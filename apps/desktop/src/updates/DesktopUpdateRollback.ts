// @effect-diagnostics nodeBuiltinImport:off -- Copying the app bundle and a detached watchdog are an imperative OS boundary with injected dependencies for focused tests.
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Electron from "electron";
import * as NodeCrypto from "node:crypto";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";

import type * as DesktopBackendPool from "../backend/DesktopBackendPool.ts";
import * as DesktopObservability from "../app/DesktopObservability.ts";

const execFile = NodeUtil.promisify(NodeChildProcess.execFile);

/** How long the new version has to report healthy before it is rolled back. */
const WATCHDOG_INTERVAL_SECONDS = 5;
const WATCHDOG_ATTEMPTS = 120;
const BACKEND_READY_TIMEOUT = Duration.seconds(WATCHDOG_INTERVAL_SECONDS * WATCHDOG_ATTEMPTS);

/**
 * Restores the previous app bundle when an installed update never reports
 * healthy. Runs detached from the app so it outlives the update restart.
 * The version is healthy once the health file contains it; if the previous
 * version comes back instead, the update simply did not apply. Either way a
 * failed version is recorded so it is never installed automatically again.
 * The attempt count, not wall-clock time, bounds the wait so a Mac that
 * sleeps mid-restart is not rolled back on wake.
 *
 * Arguments: bundle backup expected-version previous-version health-file
 * record-file interval-seconds attempts opener
 */
export const UPDATE_ROLLBACK_WATCHDOG_SCRIPT = `set -u
bundle=$1 backup=$2 expected=$3 previous=$4 health=$5 record=$6 interval=$7 attempts=$8 opener=$9
log() { printf '%s update watchdog: %s\\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }
case "$bundle" in /?*.app) ;; *) log "refusing unexpected bundle path $bundle"; exit 1 ;; esac
case "$backup" in /?*/?*) ;; *) log "refusing unexpected backup path $backup"; exit 1 ;; esac
reported() { cat "$health" 2>/dev/null || true; }
finish() {
  printf '{"version":"%s","previousVersion":"%s","outcome":"%s","at":"%s"}\\n' \\
    "$expected" "$previous" "$1" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$record.tmp" && mv -f "$record.tmp" "$record"
  log "$1: $2"
  exit 0
}
# Processes report the physical path (/tmp is /private/tmp on macOS).
physical=$(cd "$bundle" 2>/dev/null && pwd -P || printf '%s' "$bundle")
bundle_pids() {
  ps -A -o pid= -o command= | awk -v a="$bundle/Contents/" -v b="$physical/Contents/" \\
    '{ pid = $1; sub(/^[ \\t]*[0-9]+[ \\t]+/, ""); if (index($0, a) == 1 || index($0, b) == 1) print pid }'
}
i=0
while :; do
  if [ "$(reported)" = "$expected" ]; then
    rm -rf "$backup"
    log "$expected started"
    exit 0
  fi
  [ "$i" -ge "$attempts" ] && break
  i=$((i + 1))
  sleep "$interval"
done
if [ "$(reported)" = "$previous" ]; then
  rm -rf "$backup"
  finish not-applied "$previous restarted instead of $expected"
fi
[ -d "$backup" ] || finish restore-failed "no copy of $previous to restore"
pids=$(bundle_pids)
if [ -n "$pids" ]; then
  kill -TERM $pids 2>/dev/null
  j=0
  while [ "$j" -lt 10 ] && [ -n "$(bundle_pids)" ]; do j=$((j + 1)); sleep 1; done
  pids=$(bundle_pids)
  [ -n "$pids" ] && kill -KILL $pids 2>/dev/null
fi
failed="$bundle.failed-update"
rm -rf "$failed"
if [ -e "$bundle" ] && ! mv "$bundle" "$failed"; then
  finish restore-failed "could not move $expected aside"
fi
if ! mv "$backup" "$bundle"; then
  [ -e "$failed" ] && mv "$failed" "$bundle"
  finish restore-failed "could not restore $previous"
fi
rm -rf "$failed"
"$opener" "$bundle" || log "could not relaunch $bundle"
finish rolled-back "$expected did not start; restored $previous"
`;

export interface UpdateRollbackPaths {
  /** The running `.app` bundle that the update replaces. */
  readonly bundle: string;
  /** Copy of the running bundle, restored if the update fails. No `.app`
      suffix, so Launch Services never registers it as a second app. */
  readonly backup: string;
  /** Written with the app version once its local backend is ready. */
  readonly health: string;
  /** Written by the watchdog when an update failed. */
  readonly record: string;
  readonly log: string;
}

/**
 * Rollback needs a packaged macOS app running from its `.app` bundle; every
 * other build installs updates without it.
 */
export function resolveUpdateRollbackPaths(input: {
  readonly platform: NodeJS.Platform;
  readonly isPackaged: boolean;
  readonly resourcesPath: string;
  readonly stateDir: string;
  readonly logDir: string;
}): UpdateRollbackPaths | null {
  if (input.platform !== "darwin" || !input.isPackaged) return null;
  const contents = NodePath.dirname(input.resourcesPath);
  const bundle = NodePath.dirname(contents);
  if (NodePath.basename(contents) !== "Contents" || !bundle.endsWith(".app")) return null;
  const dir = NodePath.join(input.stateDir, "update-rollback");
  return {
    bundle,
    backup: NodePath.join(dir, "previous-app"),
    health: NodePath.join(dir, "healthy-version"),
    record: NodePath.join(dir, "rolled-back.json"),
    log: NodePath.join(input.logDir, "update-rollback.log"),
  };
}

export type UpdateRollbackOutcome = "rolled-back" | "not-applied" | "restore-failed";

export interface UpdateRollbackRecord {
  readonly version: string;
  readonly previousVersion: string;
  readonly outcome: UpdateRollbackOutcome;
  readonly notified: boolean;
}

function parseUpdateRollbackRecord(raw: string): UpdateRollbackRecord | null {
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    const { version, previousVersion, outcome, notified } = value;
    if (
      typeof version !== "string" ||
      typeof previousVersion !== "string" ||
      (outcome !== "rolled-back" && outcome !== "not-applied" && outcome !== "restore-failed")
    ) {
      return null;
    }
    return { version, previousVersion, outcome, notified: notified === true };
  } catch {
    return null;
  }
}

function describeUpdateRollback(record: UpdateRollbackRecord): {
  readonly title: string;
  readonly body: string;
} {
  switch (record.outcome) {
    case "rolled-back":
      return {
        title: "Update rolled back",
        body: `T3 Code ${record.version} did not start, so ${record.previousVersion} was restored. The next release will install instead.`,
      };
    case "not-applied":
      return {
        title: "Update did not install",
        body: `T3 Code ${record.version} did not install. The next release will install instead.`,
      };
    case "restore-failed":
      return {
        title: "Update rollback failed",
        body: `T3 Code ${record.version} did not start and ${record.previousVersion} could not be restored. See update-rollback.log.`,
      };
  }
}

export interface UpdateRollbackDependencies {
  readonly rename: (source: string, target: string) => Promise<void>;
  readonly copyBundle: (source: string, target: string) => Promise<void>;
  /** Starts the detached watchdog and returns its pid. */
  readonly spawnWatchdog: (args: readonly string[], logPath: string) => number | undefined;
  readonly stopWatchdog: (pid: number) => void;
  readonly makeDirectory: (path: string) => Promise<void>;
  readonly remove: (path: string) => Promise<void>;
  readonly readText: (path: string) => Promise<string | null>;
  readonly writeText: (path: string, text: string) => Promise<void>;
  readonly notify: (title: string, body: string) => Promise<void>;
}

const nodeUpdateRollbackDependencies: UpdateRollbackDependencies = {
  rename: NodeFSP.rename,
  copyBundle: async (source, target) => {
    // --clone makes an APFS copy-on-write clone, falling back to a copy.
    await execFile("/usr/bin/ditto", ["--clone", source, target]);
  },
  spawnWatchdog: (args, logPath) => {
    const logFd = NodeFS.openSync(logPath, "a");
    try {
      const child = NodeChildProcess.spawn(
        "/bin/sh",
        ["-c", UPDATE_ROLLBACK_WATCHDOG_SCRIPT, "t3-update-watchdog", ...args],
        { detached: true, stdio: ["ignore", logFd, logFd] },
      );
      child.on("error", () => undefined);
      child.unref();
      return child.pid;
    } finally {
      NodeFS.closeSync(logFd);
    }
  },
  stopWatchdog: (pid) => {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // Already gone.
    }
  },
  makeDirectory: async (path) => {
    await NodeFSP.mkdir(path, { recursive: true });
  },
  remove: (path) => NodeFSP.rm(path, { recursive: true, force: true }),
  readText: (path) => NodeFSP.readFile(path, "utf8").catch(() => null),
  writeText: (path, text) => NodeFSP.writeFile(path, text),
  notify: async (title, body) => {
    if (Electron.Notification.isSupported()) new Electron.Notification({ title, body }).show();
  },
};

/**
 * Copies the running bundle aside and starts the watchdog. Call right before
 * quitAndInstall; throws before installation when protection is not in place.
 * Failed preparations retain copies for operator recovery.
 */
export async function armUpdateRollback(
  paths: UpdateRollbackPaths,
  versions: { readonly current: string; readonly expected: string },
  dependencies: UpdateRollbackDependencies,
): Promise<number | undefined> {
  const attempt = NodeCrypto.randomUUID();
  const preparing = `${paths.backup}.preparing-${attempt}`;
  const stale = `${paths.backup}.stale-${attempt}`;
  await dependencies.makeDirectory(NodePath.dirname(paths.backup));
  await dependencies.makeDirectory(NodePath.dirname(paths.log));
  // Copy into a fresh destination. Recursive deletion of a stale bundle can fail
  // with ENOTEMPTY, so it must never be a prerequisite for rollback protection.
  await dependencies.copyBundle(paths.bundle, preparing);
  try {
    await dependencies.rename(paths.backup, stale);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  try {
    await dependencies.rename(preparing, paths.backup);
  } catch (error) {
    await dependencies.rename(stale, paths.backup).catch(() => undefined);
    throw error;
  }
  await dependencies.remove(paths.health);
  const pid = dependencies.spawnWatchdog(
    [
      paths.bundle,
      paths.backup,
      versions.expected,
      versions.current,
      paths.health,
      paths.record,
      String(WATCHDOG_INTERVAL_SECONDS),
      String(WATCHDOG_ATTEMPTS),
      "/usr/bin/open",
    ],
    paths.log,
  );
  if (pid === undefined)
    throw new Error("Rollback watchdog did not start; update was not installed.");
  // The fresh copy is published and protected before old-copy cleanup. A cleanup
  // failure leaves the old copy aside and cannot remove the active backup.
  await dependencies.remove(stale).catch(() => undefined);
  return pid;
}

/** Undoes armUpdateRollback after an install failed without restarting. */
async function disarmUpdateRollback(
  paths: UpdateRollbackPaths,
  watchdogPid: number | undefined,
  dependencies: UpdateRollbackDependencies,
): Promise<void> {
  if (watchdogPid !== undefined) dependencies.stopWatchdog(watchdogPid);
  await dependencies.remove(paths.backup);
}

/**
 * Reads the last rollback and reports it once. Its version is never
 * installed automatically again; a newer release supersedes it.
 */
export async function takeUpdateRollbackRecord(
  paths: UpdateRollbackPaths,
  dependencies: UpdateRollbackDependencies,
): Promise<UpdateRollbackRecord | null> {
  const raw = await dependencies.readText(paths.record);
  const record = raw === null ? null : parseUpdateRollbackRecord(raw);
  if (record === null || record.notified) return record;
  const { title, body } = describeUpdateRollback(record);
  await dependencies.notify(title, body).catch(() => undefined);
  const stored = JSON.parse(raw!) as Record<string, unknown>;
  await dependencies
    .writeText(paths.record, `${JSON.stringify({ ...stored, notified: true })}\n`)
    .catch(() => undefined);
  return record;
}

const { logInfo, logWarning } = DesktopObservability.makeComponentLogger("desktop-updater");

export class DesktopUpdateRollbackPreparationError extends Schema.TaggedError<DesktopUpdateRollbackPreparationError>()(
  "DesktopUpdateRollbackPreparationError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Update was not installed because rollback protection could not be prepared. Keep the current app and retry after checking available disk space and updater permissions.";
  }
}

export interface DesktopUpdateRollback {
  /** A version that failed on this Mac and must not be offered again. */
  readonly quarantinedVersion: Effect.Effect<string | null>;
  /** Loads the last rollback, then marks this version healthy once the
      local backend is ready, or at once when there is no local backend. */
  readonly start: (
    pool: DesktopBackendPool.DesktopBackendPool["Service"],
    localEnvironmentEnabled: boolean,
  ) => Effect.Effect<void, never, Scope.Scope>;
  readonly arm: (
    expectedVersion: string,
  ) => Effect.Effect<void, DesktopUpdateRollbackPreparationError>;
  readonly disarm: Effect.Effect<void>;
}

/** Rollback protection for DesktopUpdates; inert outside a macOS `.app`. */
export const make = Effect.fn("desktop.updates.makeRollback")(function* (input: {
  readonly paths: UpdateRollbackPaths | null;
  readonly appVersion: string;
  readonly dependencies?: UpdateRollbackDependencies;
}) {
  const quarantinedVersionRef = yield* Ref.make<string | null>(null);
  const watchdogPidRef = yield* Ref.make<number | undefined>(undefined);
  const { paths, appVersion } = input;
  const dependencies = input.dependencies ?? nodeUpdateRollbackDependencies;
  if (paths === null) {
    return {
      quarantinedVersion: Effect.succeed(null),
      start: () => Effect.void,
      arm: () => Effect.void,
      disarm: Effect.void,
    } satisfies DesktopUpdateRollback;
  }

  const markHealthyWhenReady = (
    pool: DesktopBackendPool.DesktopBackendPool["Service"],
    localEnvironmentEnabled: boolean,
  ) =>
    Effect.gen(function* () {
      // Polls the flag rather than waitForReady: this runs before startup
      // asks the backend to start. Without a local environment, reaching
      // startup is all there is to check.
      if (localEnvironmentEnabled) {
        const primary = yield* pool.primary;
        const ready = yield* primary.snapshot.pipe(
          Effect.map((snapshot) => snapshot.ready),
          Effect.repeat({ until: (ready) => ready, schedule: Schedule.spaced("500 millis") }),
          Effect.timeoutOption(BACKEND_READY_TIMEOUT),
        );
        if (Option.isNone(ready)) {
          return yield* logWarning("local backend did not become ready; update not marked healthy");
        }
      }
      yield* Effect.tryPromise(async () => {
        await dependencies.makeDirectory(NodePath.dirname(paths.health));
        await dependencies.writeText(paths.health, appVersion);
      }).pipe(Effect.catch(() => logWarning("could not mark this update healthy")));
    });

  return {
    quarantinedVersion: Ref.get(quarantinedVersionRef),
    start: (pool, localEnvironmentEnabled) =>
      Effect.gen(function* () {
        const record = yield* Effect.promise(() => takeUpdateRollbackRecord(paths, dependencies));
        if (record !== null) {
          yield* Ref.set(quarantinedVersionRef, record.version);
          yield* logWarning("update failed after restart and will not install automatically", {
            version: record.version,
            previousVersion: record.previousVersion,
            outcome: record.outcome,
          });
        }
        yield* markHealthyWhenReady(pool, localEnvironmentEnabled).pipe(Effect.forkScoped);
      }).pipe(
        Effect.catchCause(() => logWarning("could not load update rollback state")),
        Effect.asVoid,
      ),
    arm: (expectedVersion) =>
      Effect.tryPromise(() =>
        armUpdateRollback(paths, { current: appVersion, expected: expectedVersion }, dependencies),
      ).pipe(
        Effect.flatMap((pid) => Ref.set(watchdogPidRef, pid)),
        Effect.andThen(logInfo("update rollback armed", { expectedVersion })),
        Effect.mapError(
          (error) => new DesktopUpdateRollbackPreparationError({ cause: error.cause }),
        ),
      ),
    disarm: Ref.getAndSet(watchdogPidRef, undefined).pipe(
      Effect.flatMap((pid) => Effect.promise(() => disarmUpdateRollback(paths, pid, dependencies))),
      Effect.ignore,
    ),
  } satisfies DesktopUpdateRollback;
});
