import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type HandoffAcceptInput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { OrchestrationEventStoreLive } from "../persistence/Layers/OrchestrationEventStore.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as Registry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import { makeOrchestratorV2ReplayLayerWithRegistry } from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import * as ProviderRegistry from "../provider/Services/ProviderRegistry.ts";
import { makeHandoffService } from "./HandoffService.ts";
import * as HeldHandoffRelease from "./HeldHandoffRelease.ts";
import { initializeMetadata } from "./MetadataStore.ts";

const recipient = ThreadId.make("held-recipient");
const runtime = makeOrchestratorV2ReplayLayerWithRegistry(
  { name: "held-release" },
  Registry.makeLayer([
    {
      instanceId: ProviderInstanceId.make("codex"),
      driver: ProviderDriverKind.make("codex"),
      getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
      planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
      openSession: () => Effect.die("Release admission never needs a provider"),
    },
  ]),
  { databaseLayer: SqlitePersistenceMemory, runEffectWorker: false },
);
const live = HeldHandoffRelease.layer.pipe(
  Layer.provideMerge(Threads.layer),
  Layer.provideMerge(runtime),
  Layer.provideMerge(OrchestrationEventStoreLive),
  Layer.provideMerge(SqlitePersistenceMemory),
  Layer.provide(
    Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed([]) }),
  ),
  Layer.provideMerge(NodeServices.layer),
);
const send = (sendId: string, text: string): HandoffAcceptInput => ({
  sendId,
  recipientThreadId: recipient,
  text,
  coalesceKey: null,
  intent: "auto",
});

it.effect("an unsettle releases sends held for a settled thread, oldest first", () =>
  Effect.gen(function* () {
    const threads = yield* Threads.ThreadManagementService;
    const sql = yield* SqlClient.SqlClient;
    const release = yield* HeldHandoffRelease.HeldHandoffRelease;
    yield* initializeMetadata(sql);
    yield* release.start();
    yield* threads.dispatch({
      type: "thread.create",
      commandId: CommandId.make("create-held-recipient"),
      threadId: recipient,
      projectId: ProjectId.make("held-project"),
      title: "Held recipient",
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "fixture" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });
    yield* threads.dispatch({
      type: "thread.settle",
      commandId: CommandId.make("settle-held-recipient"),
      threadId: recipient,
    });
    // Two senders, so release must replay each under its own authenticated subject.
    const first = makeHandoffService(sql, threads, Effect.succeed([]), "first-sender");
    const second = makeHandoffService(sql, threads, Effect.succeed([]), "second-sender");
    assert.equal((yield* first.accept(send("held-1", "first held"))).status, "held");
    assert.equal((yield* second.accept(send("held-2", "second held"))).status, "held");
    assert.lengthOf((yield* threads.getThreadRecords(recipient, ["messages"])).messages, 0);

    // A plain UI/MCP unsettle, not the CLI: the server alone must deliver them.
    yield* threads.dispatch({
      type: "thread.unsettle",
      reason: "user",
      commandId: CommandId.make("unsettle-held-recipient"),
      threadId: recipient,
    });
    yield* release.drain;

    const messages = (yield* threads.getThreadRecords(recipient, ["messages"])).messages;
    assert.deepEqual(
      messages.map((message) => message.text),
      ["first held", "second held"],
    );
    for (const [service, sendId] of [
      [first, "held-1"],
      [second, "held-2"],
    ] as const) {
      const lookup = yield* service.lookup({ type: "exact", sendId });
      assert.notEqual(lookup.receipts[0]?.status, "held");
    }
  }).pipe(Effect.provide(live)),
);
