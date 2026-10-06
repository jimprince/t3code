import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { describe, expect, it } from "@effect/vitest";

import { isDiagnosticCaptureCommand, isOrphanedProviderWorker } from "./SystemRecovery.ts";

describe("SystemRecovery candidate classification", () => {
  it("recognizes bounded diagnostic capture commands", () => {
    expect(isDiagnosticCaptureCommand("python3 /tmp/storm-capture.py --duration 60")).toBe(true);
    expect(isDiagnosticCaptureCommand("/usr/bin/log stream --style compact")).toBe(true);
    expect(isDiagnosticCaptureCommand("/usr/bin/spindump 123")).toBe(true);
    expect(isDiagnosticCaptureCommand("node apps/server/dist/bin.mjs")).toBe(false);
  });

  it("only treats reparented provider binaries as orphan candidates", () => {
    expect(
      isOrphanedProviderWorker({ ppid: 1, command: "/opt/homebrew/bin/codex app-server" }),
    ).toBe(true);
    expect(
      isOrphanedProviderWorker({ ppid: 42, command: "/opt/homebrew/bin/codex app-server" }),
    ).toBe(false);
    expect(isOrphanedProviderWorker({ ppid: 1, command: "/usr/bin/syspolicyd" })).toBe(false);
  });
});

import { ProviderSessionId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProviderSessions from "../orchestration-v2/ProviderSessionManager.ts";
import * as RecoveryProcesses from "./RecoveryProcessAccess.ts";
import * as Recovery from "./SystemRecovery.ts";
import { ServerConfig } from "../config.ts";

it.live("revalidates V2 session activity and process identity before recovery", () =>
  Effect.gen(function* () {
    const threadId = ThreadId.make("recovery-thread");
    const providerSessionId = ProviderSessionId.make("recovery-session");
    let active = false;
    let released = false;
    let reusedPid = false;
    const oldTime = DateTime.makeUnsafe(DateTime.toEpochMillis(DateTime.nowUnsafe()) - 3600000);
    const row = {
      pid: 876543,
      ppid: 1,
      pgid: null,
      uid: process.getuid?.() ?? null,
      startTimeMs: 1,
      status: "S",
      cpuPercent: 50,
      rssBytes: 10,
      elapsed: "1:00",
      command: "/opt/codex app-server",
    };
    let signals = 0;
    const projectionLayer = Layer.mock(ProjectionStore.ProjectionStoreV2)({
      getShellSnapshot: () =>
        Effect.succeed({ threads: [{ id: threadId }], snapshotSequence: 1 } as never),
      getThreadRecords: () =>
        Effect.succeed({
          thread: { id: threadId },
          providerSessions: [
            {
              id: providerSessionId,
              providerInstanceId: "codex",
              status: "ready",
              updatedAt: oldTime,
            },
          ],
          runs: active ? [{ status: "running" }] : [],
        } as never),
    });
    const managerLayer = Layer.mock(ProviderSessions.ProviderSessionManagerV2)({
      release: () =>
        Effect.sync(() => {
          released = true;
        }),
      get: () => Effect.succeed(released ? Option.none() : Option.some({} as never)),
    });
    const layer = Recovery.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          NodeCrypto.layer,
          projectionLayer,
          managerLayer,
          Layer.succeed(ServerConfig, { stateDir: "/tmp/recovery-test-no-state" } as never),
          Layer.succeed(
            RecoveryProcesses.RecoveryProcessAccess,
            RecoveryProcesses.RecoveryProcessAccess.of({
              read: Effect.sync(() => [{ ...row, startTimeMs: reusedPid ? 2 : 1 }]),
              signal: () =>
                Effect.sync(() => {
                  signals++;
                  return true;
                }),
            }),
          ),
        ),
      ),
    );
    yield* Effect.gen(function* () {
      const service = yield* Recovery.SystemRecovery;
      const preview = yield* service.preview;
      expect(preview.candidates).toHaveLength(2);
      active = true;
      reusedPid = false;
      const refused = yield* service.execute({
        previewId: preview.previewId,
        candidateIds: preview.candidates.map((c) => c.candidateId),
      });
      expect(refused.actions.every((a) => a.outcome === "skipped")).toBe(true);
      expect(released).toBe(false);
      expect(signals).toBe(0);
      active = false;
      reusedPid = false;
      const reused = yield* service.preview;
      reusedPid = true;
      const reusedResult = yield* service.execute({
        previewId: reused.previewId,
        candidateIds: reused.candidates
          .filter((candidate) => candidate.kind === "process")
          .map((candidate) => candidate.candidateId),
      });
      expect(reusedResult.actions.every((action) => action.outcome === "skipped")).toBe(true);
      expect(signals).toBe(0);
      reusedPid = false;
      const fresh = yield* service.preview;
      const result = yield* service.execute({
        previewId: fresh.previewId,
        candidateIds: fresh.candidates.map((c) => c.candidateId),
      });
      expect(result.actions.map((a) => a.outcome)).toEqual(["stopped", "signaled"]);
      expect(signals).toBe(1);
      const duplicate = yield* service.execute({
        previewId: fresh.previewId,
        candidateIds: fresh.candidates.map((c) => c.candidateId),
      });
      expect(duplicate.actions.every((a) => a.outcome === "skipped")).toBe(true);
      expect(signals).toBe(1);
    }).pipe(Effect.provide(layer));
  }),
);
