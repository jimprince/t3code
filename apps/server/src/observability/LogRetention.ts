// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as Duration from "effect/Duration";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";

import { ServerConfig } from "../config.ts";

export const DEFAULT_LOG_MAX_TOTAL_BYTES = 2 * 1024 * 1024 * 1024;
export const DEFAULT_LOG_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1_000;
const DEFAULT_LOG_RETENTION_SWEEP_INTERVAL_MS = 60 * 60 * 1_000;
const SPOTLIGHT_EXCLUSION_FILE = ".metadata_never_index";

export interface LogFileCandidate {
  readonly path: string;
  readonly sizeBytes: number;
  readonly modifiedAtMs: number;
}

export interface LogRetentionPolicy {
  readonly nowMs: number;
  readonly maxAgeMs: number;
  readonly maxTotalBytes: number;
}

export interface LogRetentionResult {
  readonly deletedPaths: ReadonlyArray<string>;
  readonly deletedBytes: number;
  readonly retainedBytes: number;
}

export function selectLogFilesForPruning(
  files: ReadonlyArray<LogFileCandidate>,
  policy: LogRetentionPolicy,
): ReadonlyArray<LogFileCandidate> {
  const oldestFirst = [...files].sort(
    (left, right) => left.modifiedAtMs - right.modifiedAtMs || left.path.localeCompare(right.path),
  );
  const selected = new Set<string>();
  let retainedBytes = oldestFirst.reduce((total, file) => total + file.sizeBytes, 0);

  for (const file of oldestFirst) {
    if (policy.nowMs - file.modifiedAtMs <= policy.maxAgeMs) continue;
    selected.add(file.path);
    retainedBytes -= file.sizeBytes;
  }

  for (const file of oldestFirst) {
    if (retainedBytes <= policy.maxTotalBytes) break;
    if (selected.has(file.path)) continue;
    selected.add(file.path);
    retainedBytes -= file.sizeBytes;
  }

  return oldestFirst.filter((file) => selected.has(file.path));
}

function listLogFiles(rootDir: string): ReadonlyArray<LogFileCandidate> {
  const files: LogFileCandidate[] = [];
  const pending = [rootDir];
  while (pending.length > 0) {
    const directory = pending.pop();
    if (!directory) continue;
    for (const entry of NodeFS.readdirSync(directory, { withFileTypes: true })) {
      const entryPath = NodePath.join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        pending.push(entryPath);
        continue;
      }
      if (!entry.isFile() || entry.name === SPOTLIGHT_EXCLUSION_FILE) continue;
      const stat = NodeFS.statSync(entryPath);
      files.push({
        path: entryPath,
        sizeBytes: stat.size,
        modifiedAtMs: stat.mtimeMs,
      });
    }
  }
  return files;
}

export function pruneLogDirectory(rootDir: string, policy: LogRetentionPolicy): LogRetentionResult {
  NodeFS.mkdirSync(rootDir, { recursive: true });
  NodeFS.closeSync(NodeFS.openSync(NodePath.join(rootDir, SPOTLIGHT_EXCLUSION_FILE), "a"));

  const files = listLogFiles(rootDir);
  const selected = selectLogFilesForPruning(files, policy);
  const deletedPaths: string[] = [];
  let deletedBytes = 0;
  for (const file of selected) {
    try {
      NodeFS.unlinkSync(file.path);
      deletedPaths.push(file.path);
      deletedBytes += file.sizeBytes;
    } catch {
      // Another writer or cleanup pass may have moved the file. The next
      // periodic sweep will retry any remaining overage.
    }
  }

  const totalBytes = files.reduce((total, file) => total + file.sizeBytes, 0);
  return {
    deletedPaths,
    deletedBytes,
    retainedBytes: totalBytes - deletedBytes,
  };
}

export const LogRetentionLive = Layer.effectDiscard(
  Effect.gen(function* () {
    const { logsDir } = yield* ServerConfig;
    const sweep = Effect.gen(function* () {
      const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
      const result = yield* Effect.sync(() =>
        pruneLogDirectory(logsDir, {
          nowMs,
          maxAgeMs: DEFAULT_LOG_MAX_AGE_MS,
          maxTotalBytes: DEFAULT_LOG_MAX_TOTAL_BYTES,
        }),
      );
      yield* result.deletedPaths.length > 0
        ? Effect.logInfo("logs.retention.pruned", {
            deletedFileCount: result.deletedPaths.length,
            deletedBytes: result.deletedBytes,
            retainedBytes: result.retainedBytes,
          })
        : Effect.void;
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("logs.retention.sweep-failed", {
          logsDir,
          cause,
        }),
      ),
    );

    yield* Effect.forkScoped(
      sweep.pipe(
        Effect.repeat(Schedule.spaced(Duration.millis(DEFAULT_LOG_RETENTION_SWEEP_INTERVAL_MS))),
      ),
    );
  }),
);
