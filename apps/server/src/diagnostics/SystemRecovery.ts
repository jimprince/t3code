// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import type {
  ServerRecoveryActionResult,
  ServerRecoveryCandidate,
  ServerRecoveryExecuteInput,
  ServerRecoveryExecuteResult,
  ServerRecoveryPreviewResult,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import * as ProcessDiagnostics from "./ProcessDiagnostics.ts";
import { ServerConfig } from "../config.ts";
import { ProviderSessionDirectory } from "../provider/Services/ProviderSessionDirectory.ts";
import { ProviderService } from "../provider/Services/ProviderService.ts";

const PREVIEW_TTL_MS = 5 * 60 * 1_000;
const IDLE_PROVIDER_THRESHOLD_MS = 15 * 60 * 1_000;
const CONCURRENCY_WARNING_THRESHOLD = 8;

interface RecoveryCandidateSnapshot {
  readonly candidate: ServerRecoveryCandidate;
  readonly process?: ProcessDiagnostics.ProcessRow;
  readonly threadId?: ThreadId;
  readonly expectedLastSeenAt?: string;
}

interface RecoveryPreviewSnapshot {
  readonly previewId: string;
  readonly expiresAtMs: number;
  readonly candidates: ReadonlyMap<string, RecoveryCandidateSnapshot>;
}

export function isDiagnosticCaptureCommand(command: string): boolean {
  return (
    /(?:^|[/\s])storm-capture\.py(?:\s|$)/i.test(command) ||
    /(?:^|\s)(?:\/usr\/bin\/)?log\s+stream(?:\s|$)/i.test(command) ||
    /(?:^|\s)(?:\/usr\/sbin\/|\/usr\/bin\/)?(?:spindump|sample)(?:\s|$)/i.test(command)
  );
}

export function isOrphanedProviderWorker(input: {
  readonly ppid: number;
  readonly command: string;
}): boolean {
  if (input.ppid !== 1) return false;
  return /(?:^|[/\s])(?:codex|claude|cursor-agent|opencode|grok)(?:\s|$)/i.test(input.command);
}

function canSignalProcess(pid: number): boolean {
  if (pid <= 1 || pid === process.pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readRecentPressureIncident(stateDir: string, nowMs: number): string | undefined {
  try {
    const parsed = JSON.parse(
      NodeFS.readFileSync(NodePath.join(stateDir, "system-pressure.json"), "utf8"),
    ) as Record<string, unknown>;
    if (
      typeof parsed.detectedAt !== "string" ||
      typeof parsed.reason !== "string" ||
      parsed.reason.length === 0 ||
      parsed.reason.length > 240
    ) {
      return undefined;
    }
    const detectedAtMs = Date.parse(parsed.detectedAt);
    if (Number.isNaN(detectedAtMs) || nowMs - detectedAtMs > 30 * 60 * 1_000) {
      return undefined;
    }
    const cpu =
      typeof parsed.hostCpuPercent === "number" && Number.isFinite(parsed.hostCpuPercent)
        ? ` (${parsed.hostCpuPercent.toFixed(0)}% host CPU)`
        : "";
    return `Recent detector incident: ${parsed.reason}${cpu}.`;
  } catch {
    return undefined;
  }
}

function ancestorPids(rows: ReadonlyArray<ProcessDiagnostics.ProcessRow>): ReadonlySet<number> {
  const byPid = new Map(rows.map((row) => [row.pid, row]));
  const ancestors = new Set<number>();
  let current = byPid.get(process.pid);
  while (current && current.ppid > 0 && !ancestors.has(current.ppid)) {
    ancestors.add(current.ppid);
    current = byPid.get(current.ppid);
  }
  return ancestors;
}

function processCandidate(
  row: ProcessDiagnostics.ProcessRow,
  groupId: "diagnostic-captures" | "orphaned-provider-workers",
): RecoveryCandidateSnapshot {
  return {
    process: row,
    candidate: {
      candidateId: `process:${row.pid}:${groupId}`,
      groupId,
      kind: "process",
      label: `${groupId === "diagnostic-captures" ? "Diagnostic capture" : "Orphaned provider"} (PID ${row.pid})`,
      detail: row.command,
      recommended: groupId === "diagnostic-captures" || row.cpuPercent >= 25,
      pid: Option.some(row.pid),
      threadId: Option.none(),
      cpuPercent: Option.some(row.cpuPercent),
      rssBytes: Option.some(row.rssBytes),
    },
  };
}

export class SystemRecovery extends Context.Service<
  SystemRecovery,
  {
    readonly preview: Effect.Effect<ServerRecoveryPreviewResult>;
    readonly execute: (
      input: ServerRecoveryExecuteInput,
    ) => Effect.Effect<ServerRecoveryExecuteResult>;
  }
>()("t3/diagnostics/SystemRecovery") {}

export const make = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const directory = yield* ProviderSessionDirectory;
  const providerService = yield* ProviderService;
  const { stateDir } = yield* ServerConfig;
  const latestPreview = yield* Ref.make<Option.Option<RecoveryPreviewSnapshot>>(Option.none());
  const previewSequence = yield* Ref.make(0);

  const preview: SystemRecovery["Service"]["preview"] = Effect.gen(function* () {
    const createdAt = yield* DateTime.now;
    const createdAtMs = DateTime.toEpochMillis(createdAt);
    const expiresAt = DateTime.makeUnsafe(createdAtMs + PREVIEW_TTL_MS);
    const sequence = yield* Ref.getAndUpdate(previewSequence, (current) => current + 1);
    const previewId = yield* crypto.randomUUIDv4.pipe(
      Effect.map((value) => value.replaceAll("-", "")),
      Effect.orElseSucceed(() => `${createdAtMs.toString(36)}-${sequence.toString(36)}`),
    );
    const bindings = yield* directory.listBindings().pipe(Effect.orElseSucceed(() => []));
    const rows = yield* ProcessDiagnostics.readProcessRows.pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      Effect.orElseSucceed(() => []),
    );
    const ancestors = ancestorPids(rows);
    const snapshots: RecoveryCandidateSnapshot[] = [];

    for (const binding of bindings) {
      const lastSeenAtMs = Date.parse(binding.lastSeenAt);
      if (
        binding.status === "stopped" ||
        binding.activeTurnId != null ||
        Number.isNaN(lastSeenAtMs) ||
        createdAtMs - lastSeenAtMs < IDLE_PROVIDER_THRESHOLD_MS
      ) {
        continue;
      }
      snapshots.push({
        threadId: binding.threadId,
        expectedLastSeenAt: binding.lastSeenAt,
        candidate: {
          candidateId: `session:${binding.threadId}`,
          groupId: "idle-provider-sessions",
          kind: "provider-session",
          label: `Idle ${binding.provider} session`,
          detail: `Thread ${binding.threadId}; idle for at least 15 minutes`,
          recommended: true,
          pid: Option.none(),
          threadId: Option.some(binding.threadId),
          cpuPercent: Option.none(),
          rssBytes: Option.none(),
        },
      });
    }

    for (const row of rows) {
      if (!canSignalProcess(row.pid) || ancestors.has(row.pid)) continue;
      if (isDiagnosticCaptureCommand(row.command)) {
        snapshots.push(processCandidate(row, "diagnostic-captures"));
      } else if (isOrphanedProviderWorker(row)) {
        snapshots.push(processCandidate(row, "orphaned-provider-workers"));
      }
    }

    const activeProviderCount = bindings.filter((binding) => binding.status !== "stopped").length;
    const recentPressureIncident = readRecentPressureIncident(stateDir, createdAtMs);
    const warnings = [
      ...(recentPressureIncident ? [recentPressureIncident] : []),
      ...(activeProviderCount > CONCURRENCY_WARNING_THRESHOLD
        ? [
            `${activeProviderCount} provider sessions are currently warm or active. T3 does not enforce a concurrency cap.`,
          ]
        : []),
    ];
    const candidates = new Map(
      snapshots.map((snapshot) => [snapshot.candidate.candidateId, snapshot]),
    );
    yield* Ref.set(
      latestPreview,
      Option.some({
        previewId,
        expiresAtMs: DateTime.toEpochMillis(expiresAt),
        candidates,
      }),
    );
    return {
      previewId,
      createdAt,
      expiresAt,
      candidates: snapshots.map((snapshot) => snapshot.candidate),
      warnings,
      automaticRecovery: false,
    };
  });

  const execute: SystemRecovery["Service"]["execute"] = Effect.fn("SystemRecovery.execute")(
    function* (input) {
      const completedAt = yield* DateTime.now;
      const current = Option.getOrUndefined(yield* Ref.get(latestPreview));
      const selectedIds = [...new Set(input.candidateIds)];
      if (
        current === undefined ||
        current.previewId !== input.previewId ||
        current.expiresAtMs < DateTime.toEpochMillis(completedAt)
      ) {
        return {
          previewId: input.previewId,
          completedAt,
          actions: selectedIds.map(
            (candidateId): ServerRecoveryActionResult => ({
              candidateId,
              outcome: "skipped",
              message: Option.some("Recovery preview expired; refresh before attempting recovery."),
            }),
          ),
        };
      }

      const currentRows = yield* ProcessDiagnostics.readProcessRows.pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.orElseSucceed(() => []),
      );
      const currentRowsByPid = new Map(currentRows.map((row) => [row.pid, row]));
      const actions: ServerRecoveryActionResult[] = [];
      for (const candidateId of selectedIds) {
        const snapshot = current.candidates.get(candidateId);
        if (!snapshot) {
          actions.push({
            candidateId,
            outcome: "skipped",
            message: Option.some("Candidate was not part of this recovery preview."),
          });
          continue;
        }

        if (snapshot.threadId !== undefined) {
          const claimed = yield* directory
            .claimIdleForRecovery({
              threadId: snapshot.threadId,
              expectedLastSeenAt: snapshot.expectedLastSeenAt ?? "",
            })
            .pipe(Effect.orElseSucceed(() => false));
          if (!claimed) {
            actions.push({
              candidateId,
              outcome: "skipped",
              message: Option.some(
                "The provider session changed or started a turn after the preview.",
              ),
            });
            continue;
          }
          const exit = yield* Effect.exit(
            providerService.stopSession({ threadId: snapshot.threadId }),
          );
          actions.push(
            Exit.isSuccess(exit)
              ? { candidateId, outcome: "stopped", message: Option.none() }
              : {
                  candidateId,
                  outcome: "failed",
                  message: Option.some("The provider session could not be stopped."),
                },
          );
          continue;
        }

        const expected = snapshot.process;
        const live = expected ? currentRowsByPid.get(expected.pid) : undefined;
        if (
          !expected ||
          !live ||
          live.ppid !== expected.ppid ||
          live.command !== expected.command ||
          !canSignalProcess(expected.pid)
        ) {
          actions.push({
            candidateId,
            outcome: "skipped",
            message: Option.some("Process identity changed or the process already exited."),
          });
          continue;
        }

        const signaled = yield* Effect.sync(() => {
          try {
            process.kill(expected.pid, "SIGINT");
            return true;
          } catch {
            return false;
          }
        });
        actions.push(
          signaled
            ? {
                candidateId,
                outcome: "signaled",
                message: Option.some("SIGINT sent; no force kill was attempted."),
              }
            : {
                candidateId,
                outcome: "failed",
                message: Option.some("The process could not be signaled."),
              },
        );
      }

      yield* Ref.set(latestPreview, Option.none());
      return {
        previewId: input.previewId,
        completedAt,
        actions,
      };
    },
  );

  return SystemRecovery.of({ preview, execute });
});

export const layer = Layer.effect(SystemRecovery, make);
