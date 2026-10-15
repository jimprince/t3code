import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type RuntimeMode,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { layerMemory } from "../persistence/Sqlite.ts";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import * as Adapters from "../orchestration-v2/ProviderAdapterRegistry.ts";
import { layerWithRegistry } from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import { layer as storeLayer } from "../automations/AutomationStore.ts";

export const subheadModel = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6.1-sol" };
export const subheadProject = ProjectId.make("project");
const runtime = layerWithRegistry(
  { name: "virtual-subheads" },
  Adapters.layerFromAdapters([
    {
      instanceId: subheadModel.instanceId,
      driver: ProviderDriverKind.make("codex"),
      getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
      planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
      openSession: () => Effect.die("Subhead persistence tests never execute a provider"),
    },
  ]),
  { databaseLayer: layerMemory, runEffectWorker: false },
);
export const subheadNativeLayer = Layer.mergeAll(
  Threads.layer.pipe(Layer.provideMerge(runtime)),
  storeLayer,
).pipe(Layer.provideMerge(layerMemory));
export const createSubheadTestThread = (id: ThreadId, runtimeMode: RuntimeMode = "full-access") =>
  Effect.gen(function* () {
    yield* (yield* Threads.ThreadManagementService).dispatch({
      type: "thread.create",
      commandId: CommandId.make(`create:${id}`),
      threadId: id,
      projectId: subheadProject,
      title: id,
      modelSelection: subheadModel,
      createdBy: "user",
      creationSource: "server",
      runtimeMode,
      interactionMode: "default",
      branch: null,
      worktreePath: null,
    });
  });
export const sendSubheadTestMessage = (id: ThreadId, suffix = "first") =>
  Effect.gen(function* () {
    return yield* (yield* Threads.ThreadManagementService).dispatch({
      type: "message.dispatch",
      commandId: CommandId.make(`message:${id}:${suffix}`),
      messageId: MessageId.make(`message:${id}:${suffix}`),
      threadId: id,
      text: "Work",
      attachments: [],
      createdBy: "user",
      creationSource: "server",
      dispatchMode: { type: "start_immediately" },
    });
  });
