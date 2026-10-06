import { describe, expect, it } from "vite-plus/test";
import {
  CommandId,
  ProviderDriverKind,
  ProviderThreadId,
  ProviderTurnId,
  RunAttemptId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import * as Outbox from "../../orchestration-v2/EffectOutbox.ts";
import {
  makeProviderEventRoutingState,
  routeProviderEvent,
} from "../../orchestration-v2/RunExecutionService.ts";
import type { ProviderAdapterV2Event } from "../../orchestration-v2/ProviderAdapter.ts";

for (const driverName of ["codex", "claudeAgent", "cursor", "grok", "opencode", "antigravity"]) {
  describe(driverName, () => {
    it("rejects old completion after a replacement owns the turn and accepts the replacement", () => {
      const driver = ProviderDriverKind.make(driverName);
      const identity = {
        threadId: ThreadId.make(`${driverName}:thread`),
        runId: RunId.make(`${driverName}:run`),
        attemptId: RunAttemptId.make(`${driverName}:replacement`),
        providerThreadId: ProviderThreadId.make(`${driverName}:provider-thread`),
      };
      const oldTurn = ProviderTurnId.make(`${driverName}:old`);
      const currentTurn = ProviderTurnId.make(`${driverName}:current`);
      const state = makeProviderEventRoutingState({ identity, providerTurnId: currentTurn });
      const terminal = (id: ProviderTurnId): ProviderAdapterV2Event => ({
        type: "turn.terminal",
        driver,
        providerThreadId: identity.providerThreadId,
        providerTurnId: id,
        runOrdinal: 1,
        status: "completed",
        failure: null,
        threadDisposition: "reusable",
      });
      expect(routeProviderEvent(terminal(oldTurn), identity, state)[0]).toBe(false);
      const [accepted, next] = routeProviderEvent(terminal(currentTurn), identity, state);
      expect(accepted).toBe(true);
      expect(next.rootTurnEnded).toBe(true);
    });
  });
}

it("retains an accepted continuation once across process loss and completion/retry ownership", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const outbox = yield* Outbox.EffectOutboxV2;
      const pending = {
        id: "accepted-continuation",
        commandId: CommandId.make("accepted-command"),
        threadId: ThreadId.make("accepted-thread"),
        request: {
          type: "provider-runtime.continue",
          sourceRunId: RunId.make("accepted-run"),
        } as const,
      };
      yield* outbox.enqueue([pending]);
      yield* outbox.enqueue([pending]);
      const claim = yield* outbox.claimNext({ workerId: "old-owner", leaseDurationMs: 1000 });
      expect(Option.isSome(claim)).toBe(true);
      yield* outbox.reconcileAfterProcessLoss;
      const recovered = yield* outbox.claimNext({ workerId: "new-owner", leaseDurationMs: 1000 });
      expect(Option.isSome(recovered)).toBe(true);
      expect(yield* outbox.succeed({ effectId: pending.id, workerId: "old-owner" })).toBe(false);
      expect(yield* outbox.succeed({ effectId: pending.id, workerId: "new-owner" })).toBe(true);
      expect(
        yield* outbox.retry({
          effectId: pending.id,
          workerId: "new-owner",
          error: "late retry",
          delayMs: 0,
        }),
      ).toBe(false);
      const rows = yield* outbox.listByCommandId(pending.commandId);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.status).toBe("succeeded");
    }).pipe(
      Effect.provide(Outbox.layer.pipe(Layer.provide(SqlitePersistenceMemory))),
      Effect.scoped,
    ),
  );
});
