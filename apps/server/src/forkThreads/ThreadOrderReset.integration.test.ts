import { assert, it } from "@effect/vitest";
import { CommandId, ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import { makeOrchestratorV2ReplayLayerWithRegistry } from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import { resetThreadOrder } from "./ThreadOrderReset.ts";
const runtime = makeOrchestratorV2ReplayLayerWithRegistry(
  { name: "fork-order-reset" },
  ProviderAdapterRegistry.makeLayer([]),
  { runEffectWorker: false },
);
const layer = ThreadManagement.layer.pipe(Layer.provide(runtime));
it.effect(
  "native receipts reset only the current section and preserve pin/activity on repeat",
  () =>
    Effect.gen(function* () {
      const management = yield* ThreadManagement.ThreadManagementService;
      const threadId = ThreadId.make("orderable");
      yield* management.dispatch({
        type: "thread.create",
        commandId: CommandId.make("create"),
        threadId,
        projectId: ProjectId.make("project"),
        title: "Order",
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "model" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdBy: "user",
        creationSource: "web",
      });
      yield* management.dispatch({
        type: "thread.active.reorder",
        commandId: CommandId.make("active-order"),
        threadId,
        orderKey: "a0",
      });
      const beforeActive = (yield* management.getThreadShell(threadId))!;
      yield* resetThreadOrder(management, { threadId, commandId: CommandId.make("reset-active") });
      const active = (yield* management.getThreadShell(threadId))!;
      assert.equal(active.activeOrderKey, null);
      assert.deepStrictEqual(active.updatedAt, beforeActive.updatedAt);
      yield* management.dispatch({
        type: "thread.pin",
        commandId: CommandId.make("pin"),
        threadId,
        orderKey: "a0",
      });
      const beforePin = (yield* management.getThreadShell(threadId))!;
      yield* resetThreadOrder(management, { threadId, commandId: CommandId.make("reset-pin") });
      yield* resetThreadOrder(management, { threadId, commandId: CommandId.make("reset-pin") });
      const pinned = (yield* management.getThreadShell(threadId))!;
      assert.equal(pinned.pinOrderKey, null);
      assert.deepStrictEqual(pinned.pinnedAt, beforePin.pinnedAt);
      assert.deepStrictEqual(pinned.updatedAt, beforePin.updatedAt);
      yield* management.dispatch({
        type: "thread.settle",
        commandId: CommandId.make("settle"),
        threadId,
      });
      assert.equal(
        (yield* Effect.exit(
          resetThreadOrder(management, { threadId, commandId: CommandId.make("reset-settled") }),
        ))._tag,
        "Failure",
      );
      yield* management.dispatch({
        type: "thread.archive",
        commandId: CommandId.make("archive"),
        threadId,
      });
      assert.equal(
        (yield* Effect.exit(
          resetThreadOrder(management, { threadId, commandId: CommandId.make("reset-archived") }),
        ))._tag,
        "Failure",
      );
      assert.equal(
        (yield* Effect.exit(
          resetThreadOrder(management, {
            threadId: ThreadId.make("missing"),
            commandId: CommandId.make("reset-missing"),
          }),
        ))._tag,
        "Failure",
      );
    }).pipe(Effect.provide(layer)),
);
