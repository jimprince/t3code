import { assert, it } from "@effect/vitest";
import { CommandId, EventId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import {
  v2Projection,
  v2Now,
} from "../../../../packages/client-runtime/src/state/orchestrationV2TestFixtures.ts";
import * as Sink from "../orchestration-v2/EventSink.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as Registry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import { layerWithRegistry as makeOrchestratorV2ReplayLayerWithRegistry } from "../orchestration-v2/testkit/ProviderReplayHarness.ts";

const registry = Layer.succeed(
  Registry.ProviderAdapterRegistryV2,
  Registry.ProviderAdapterRegistryV2.of({
    get: () => Effect.die("No provider should be started by archival"),
    list: () => Effect.succeed([]),
  }),
);
const live = makeOrchestratorV2ReplayLayerWithRegistry(
  { name: "transfer-archive-guard" },
  registry,
  { runEffectWorker: false },
);
it.effect(
  "rejects archival when the source changed during transfer and accepts an unchanged durable source",
  () =>
    Effect.gen(function* () {
      const sink = yield* Sink.EventSinkV2;
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const id = ThreadId.make("transfer-source");
      yield* sink.write({
        events: [
          {
            id: EventId.make("transfer-source-created"),
            type: "thread.created",
            threadId: id,
            occurredAt: v2Now,
            payload: { ...v2Projection.thread, id },
          },
        ],
      });
      yield* orchestrator.dispatch({
        type: "thread.metadata.update",
        commandId: CommandId.make("source-edit"),
        threadId: id,
        title: "New work after export",
      });
      const stale = yield* Effect.result(
        orchestrator.dispatch({
          type: "thread.archive",
          commandId: CommandId.make("stale-source-archive"),
          threadId: id,
          transferExpectedUpdatedAt: v2Now,
        }),
      );
      assert.equal(stale._tag, "Failure");
      const current = yield* orchestrator.getThreadProjection(id);
      assert.equal(current.thread.archivedAt, null);
      assert.equal(current.thread.title, "New work after export");
      yield* orchestrator.dispatch({
        type: "thread.archive",
        commandId: CommandId.make("durable-source-archive"),
        threadId: id,
        transferExpectedUpdatedAt: current.thread.updatedAt,
      });
      assert.notEqual((yield* orchestrator.getThreadProjection(id)).thread.archivedAt, null);
    }).pipe(Effect.provide(live)),
);
