// @effect-diagnostics nodeBuiltinImport:off -- The Mac dev kit is driven through its own shell script.
import type { DesktopUpdateState } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeUtil from "node:util";

import type * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import {
  reduceDesktopUpdateStateOnNoUpdate,
  reduceDesktopUpdateStateOnUpdateAvailable,
} from "./updateMachine.ts";

/**
 * T3 Code (Dev) on Brad's Mac is the fork's `vp run dev:desktop` app, installed and kept current
 * by the t3-mac-dev kit (`~/t3-mac-dev`, checkout `~/Developer/t3code-dev`). Its update button
 * reuses the kit's two entry points instead of electron-updater: `dev-launch.sh --status`
 * (read-only, fetches origin) answers Check, and `dev-launch.sh` (the Dock click handler, which
 * kicks the kit's update LaunchAgent) answers Update.
 */
export interface DevKit {
  readonly script: string;
  /** The kit's append-only updater output; it shows what a running rebuild is doing. */
  readonly logPath: string;
  readonly checkout: string;
  /**
   * The checkout's HEAD when this app started, i.e. the commit its main process was built from.
   * The kit's own revision reports can lag (a run marked failed leaves them stale), so Check
   * trusts this one. Null when git could not say.
   */
  readonly appSha: string | null;
}

export class DevKitUpdateError extends Schema.TaggedError<DevKitUpdateError>()(
  "DevKitUpdateError",
  { message: Schema.String },
) {}

export interface DevKitStatus {
  /** The commit this build was made from, when the kit says; null when it does not. */
  readonly builtSha: string | null;
  /** The followed branch's tip on origin, when the kit says. */
  readonly liveSha: string | null;
  readonly branch: string;
  readonly needsUpdate: boolean;
  readonly workerRunning: boolean;
}

/** Only the kit's own app qualifies: a dev app from any other checkout must not rebuild the kit's. */
export const resolve = (
  environment: DesktopEnvironment.DesktopEnvironment["Service"],
  fileSystem: FileSystem.FileSystem,
): Effect.Effect<Option.Option<DevKit>> =>
  Effect.gen(function* () {
    const { path, homeDirectory } = environment;
    if (
      environment.platform !== "darwin" ||
      !environment.isDevelopment ||
      environment.rootDir !== path.join(homeDirectory, "Developer", "t3code-dev")
    ) {
      return Option.none<DevKit>();
    }
    const script = path.join(homeDirectory, "t3-mac-dev", "dev-launch.sh");
    if (!(yield* fileSystem.exists(script).pipe(Effect.orElseSucceed(() => false)))) {
      return Option.none<DevKit>();
    }
    const checkout = environment.rootDir;
    const appSha = Option.getOrNull(
      yield* git(checkout, ["rev-parse", "HEAD"]).pipe(Effect.option),
    );
    return Option.some({
      script,
      checkout,
      appSha: appSha === null ? null : SHA_ONLY.test(appSha.trim()) ? appSha.trim() : null,
      logPath: path.join(homeDirectory, ".t3-code-dev-kit", "launch.log"),
    });
  });

const SHA = /[0-9a-f]{7,40}/;

/**
 * Reads the output of `dev-launch.sh --status`; null when it is not that output. The kit reports
 * the build either as `checkout:` (its git HEAD) or, newer, as `verified app revision:` (the
 * revision its last verified launch built), which wins. Full SHAs are cut to the length the
 * kit prints for origin, nine characters when origin is missing or also full.
 */
export function parseDevKitStatus(output: string): (DevKitStatus & { fetched: boolean }) | null {
  const needs = output.match(/^needs update:\s+(yes|no)/m);
  if (!needs) return null;
  const verified = output.match(new RegExp(`^verified app revision:\\s+(${SHA.source})`, "m"));
  const checkout = output.match(new RegExp(`^checkout:\\s+(${SHA.source})`, "m"));
  const live = output.match(new RegExp(`^origin/\\S+:\\s+(${SHA.source})`, "m"));
  const length = live && live[1]!.length < 40 ? live[1]!.length : 9;
  const short = (sha: string | undefined) => (sha ? sha.slice(0, length) : null);
  const fetched = output.match(/fetched:\s+(\S+)/);
  return {
    branch: output.match(/^branch followed:\s+(\S+)/m)?.[1] ?? "live",
    fetched: fetched ? fetched[1] === "yes" : true,
    builtSha: short(verified?.[1] ?? checkout?.[1]),
    liveSha: short(live?.[1]),
    needsUpdate: needs[1] === "yes",
    workerRunning: output.match(/update worker:\s+(\w+)/)?.[1] === "running",
  };
}

export interface DevKitVerdict {
  readonly branch: string;
  readonly builtSha: string | null;
  readonly liveSha: string | null;
  /** origin has a commit this build needs a rebuild or a hot reload to reach. */
  readonly behind: boolean;
  /** origin differs from this build only in files the kit hot-reloads without a restart. */
  readonly hotReload: boolean;
}

const sameCommit = (a: string, b: string) => a.startsWith(b) || b.startsWith(a);

// The kit applies exactly these paths without restarting the app (dev-launch.sh worker).
const isHotReloadPath = (file: string) =>
  file.startsWith("apps/web/src/") ||
  file.startsWith("apps/web/public/") ||
  file.startsWith("docs/") ||
  file.endsWith(".md");

/**
 * Decides Check from the SHAs it will show, not from the kit's `needs update` flag, which can be
 * stale. This build is the app's own start commit, else what the kit reports. `changedPaths` is
 * what origin changed since this build (null until asked for); with only hot-reloadable paths
 * the running app is current.
 */
export function decideVerdict(
  status: DevKitStatus,
  appSha: string | null,
  changedPaths: ReadonlyArray<string> | null,
): DevKitVerdict {
  const length = status.liveSha?.length ?? 9;
  const builtSha = appSha ? appSha.slice(0, length) : status.builtSha;
  const liveSha = status.liveSha;
  // Without both SHAs there is nothing to compare, so the kit's flag is all there is.
  const behind =
    builtSha !== null && liveSha !== null ? !sameCommit(builtSha, liveSha) : status.needsUpdate;
  const hotReload = behind && changedPaths !== null && changedPaths.every(isHotReloadPath);
  return { branch: status.branch, builtSha, liveSha, behind: behind && !hotReload, hotReload };
}

/** Reads the verdict for a status, asking git what origin changed only when the SHAs differ. */
export const evaluateStatus = (kit: DevKit, status: DevKitStatus): Effect.Effect<DevKitVerdict> =>
  Effect.gen(function* () {
    const first = decideVerdict(status, kit.appSha, null);
    if (!first.behind || kit.appSha === null || status.liveSha === null) return first;
    const changed = yield* git(kit.checkout, [
      "diff",
      "--name-only",
      kit.appSha,
      status.liveSha,
    ]).pipe(Effect.option);
    return Option.isNone(changed)
      ? first
      : decideVerdict(status, kit.appSha, changed.value.split("\n").filter(Boolean));
  });

/** The state the button shows for one verdict; both SHAs are in the message. */
export function reduceStateOnDevKitVerdict(
  state: DesktopUpdateState,
  verdict: DevKitVerdict,
  checkedAt: string,
): DesktopUpdateState {
  const { liveSha, builtSha } = verdict;
  const origin = `origin/${verdict.branch}`;
  if (verdict.behind) {
    return {
      ...reduceDesktopUpdateStateOnUpdateAvailable(state, liveSha ?? origin, checkedAt),
      message: `${origin} is at ${liveSha ?? "a newer commit"}, ahead of this build${builtSha ? ` (${builtSha})` : ""}.`,
    };
  }
  const message = verdict.hotReload
    ? `Up to date: ${origin} is at ${liveSha}, which differs from this build (${builtSha}) only in web or docs files the kit hot-reloads.`
    : `Up to date: ${origin}${(liveSha ?? builtSha) ? ` is at ${liveSha ?? builtSha}, the commit this build was made from` : " has not moved past this build"}.`;
  return { ...reduceDesktopUpdateStateOnNoUpdate(state, checkedAt), message };
}

/** What a running rebuild is doing, from the kit's log text written since the update was pressed. */
export function summarizeKitLog(text: string): { step: string | null; progress: string | null } {
  const steps = [...text.matchAll(/^==> (.+)$/gm)];
  const lastStep = steps.at(-1);
  // pnpm progress from an earlier step says nothing about this one.
  const sinceStep = lastStep ? text.slice(lastStep.index) : text;
  const progress = [...sinceStep.matchAll(/resolved (\d+), reused (\d+)/g)].at(-1);
  return {
    step: lastStep ? lastStep[1]!.trim().slice(0, 80) : null,
    progress: progress ? `resolved ${progress[1]}, reused ${progress[2]}` : null,
  };
}

export const STUCK_AFTER_MS = 120_000;

const duration = (ms: number) => {
  const seconds = Math.max(0, Math.round(ms / 1000));
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
};

/**
 * The update card's line while the kit rebuilds. `idleMs` is the time since the log last changed
 * (or since the press, when it has not changed yet); past STUCK_AFTER_MS it says so plainly.
 */
export function describeRebuild(input: {
  readonly target: string | null;
  readonly step: string | null;
  readonly progress: string | null;
  readonly elapsedMs: number;
  readonly idleMs: number;
  readonly logPath: string;
}): string {
  const parts = [
    input.step ?? "Waiting for the kit to start",
    ...(input.progress ? [input.progress] : []),
    `${duration(input.elapsedMs)} elapsed`,
    `last activity ${duration(input.idleMs)} ago`,
  ];
  const head = `Rebuilding T3 Code (Dev)${input.target ? ` at ${input.target}` : ""}: ${parts.join(" · ")}.`;
  return input.idleMs >= STUCK_AFTER_MS
    ? `${head} No log activity for ${duration(input.idleMs)}; it may be stuck. Log: ${input.logPath}`
    : `${head} The app quits and relaunches when it is done.`;
}

/** The log's size, to start reading from where this update began. 0 when there is no log. */
export const logSize = (kit: DevKit): Effect.Effect<number> =>
  Effect.tryPromise(() => NodeFSP.stat(kit.logPath).then((stat) => stat.size)).pipe(
    Effect.orElseSucceed(() => 0),
  );

/** The last 64 KB of the log from `offset` on, with its modification time; none if unreadable. */
export const readLog = (
  kit: DevKit,
  offset: number,
): Effect.Effect<Option.Option<{ text: string; mtimeMs: number }>> =>
  Effect.tryPromise(async () => {
    const handle = await NodeFSP.open(kit.logPath, "r");
    try {
      const { size, mtimeMs } = await handle.stat();
      const start = Math.max(size < offset ? 0 : offset, size - 65_536);
      const buffer = Buffer.alloc(size - start);
      await handle.read(buffer, 0, buffer.length, start);
      return { text: buffer.toString("utf8"), mtimeMs };
    } finally {
      await handle.close();
    }
  }).pipe(Effect.option);

const execFile = NodeUtil.promisify(NodeChildProcess.execFile);
const SHA_ONLY = /^[0-9a-f]{40}$/;

const git = (cwd: string, args: ReadonlyArray<string>) =>
  Effect.tryPromise(() => execFile("git", [...args], { cwd, timeout: 15_000 })).pipe(
    Effect.map(({ stdout }) => stdout),
  );

const runKit = (kit: DevKit, args: ReadonlyArray<string>) =>
  Effect.tryPromise({
    try: () => execFile("/bin/bash", [kit.script, ...args], { timeout: 60_000 }),
    catch: (cause) =>
      new DevKitUpdateError({
        message: `The dev kit script failed: ${cause instanceof Error ? cause.message : String(cause)}`,
      }),
  });

export const readStatus = (kit: DevKit): Effect.Effect<DevKitStatus, DevKitUpdateError> =>
  runKit(kit, ["--status"]).pipe(
    Effect.flatMap(({ stdout }) => {
      const status = parseDevKitStatus(stdout);
      if (status === null) {
        return Effect.fail(
          new DevKitUpdateError({ message: "The dev kit status was unreadable." }),
        );
      }
      return status.fetched
        ? Effect.succeed(status)
        : Effect.fail(
            new DevKitUpdateError({
              message: `Could not reach origin/${status.branch}; check the network and try again.`,
            }),
          );
    }),
  );

/** Asks the kit's update LaunchAgent to pull, rebuild and relaunch; returns once it is accepted. */
export const requestUpdate = (kit: DevKit): Effect.Effect<void, DevKitUpdateError> =>
  runKit(kit, []).pipe(Effect.asVoid);
