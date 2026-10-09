import { ProviderInstanceId, ProviderDriverKind } from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as Registry from "../provider/Services/ProviderInstanceRegistry.ts";
import type { ProviderInstance } from "../provider/ProviderDriver.ts";
import * as Project from "../project/ProjectService.ts";
import * as Git from "../git/GitWorkflowService.ts";
import * as Checkpoint from "../checkpointing/CheckpointStore.ts";
import * as Vcs from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as SourceControl from "../sourceControl/SourceControlProviderRegistry.ts";
import * as Mcp from "../mcp/McpSessionRegistry.testkit.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as Locks from "../orchestration-v2/ThreadCommandExecutor.ts";
import {
  OrchestrationV2LayerLive,
  OrchestrationV2EventSinkLayerLive,
} from "../orchestration-v2/runtimeLayer.ts";
import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as RecoveryStore from "./RecoveryStore.ts";
import * as Reset from "./SessionResetService.ts";
import * as Incarnation from "./ServerIncarnation.ts";

const modelSelection = { instanceId: ProviderInstanceId.make("codex"), model: "test" };
const driver = ProviderDriverKind.make("codex");
const instance = {
  instanceId: modelSelection.instanceId,
  driverKind: driver,
  continuationIdentity: { driverKind: driver, continuationKey: "codex:test" },
  displayName: "test",
  enabled: true,
  snapshot: { getSnapshot: Effect.succeed({}) } as ProviderInstance["snapshot"],
  orchestrationAdapter: {
    instanceId: modelSelection.instanceId,
    driver,
    getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
    planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
    openSession: () => Effect.die("No provider start in receipt tests"),
  },
  textGeneration: {} as ProviderInstance["textGeneration"],
} satisfies ProviderInstance;
const config = ServerConfig.layerTest(process.cwd(), { prefix: "resume-cas-" });
const platform = Layer.merge(
  NodeServices.layer,
  Layer.mock(SourceControl.SourceControlProviderRegistry)({
    resolveLink: () => Effect.die("unused"),
  }),
);
const vcs = Vcs.layer.pipe(
  Layer.provide(VcsProcess.layer),
  Layer.provide(config),
  Layer.provide(platform),
);
const native = Layer.mergeAll(
  OrchestrationV2LayerLive,
  OrchestrationV2EventSinkLayerLive,
  Locks.layer,
  ProjectStore.layer,
  RecoveryStore.layer,
  Incarnation.layer,
).pipe(
  Layer.provide(Mcp.layer),
  Layer.provideMerge(SqlitePersistenceMemory),
  Layer.provide(Checkpoint.layer.pipe(Layer.provide(vcs))),
  Layer.provide(config),
  Layer.provide(ServerSettings.layerTest()),
  Layer.provide(
    Layer.succeed(Registry.ProviderInstanceRegistry, {
      getInstance: (id) => Effect.succeed(id === instance.instanceId ? instance : undefined),
      listInstances: Effect.succeed([instance]),
      listUnavailable: Effect.succeed([]),
      streamChanges: Stream.empty,
      subscribeChanges: Effect.never,
    }),
  ),
  Layer.provide(
    Layer.mock(Git.GitWorkflowService)({
      pruneWorktrees: () => Effect.void,
      createWorktree: () => Effect.die("unused"),
    }),
  ),
  Layer.provide(
    Layer.mock(Project.ProjectService)({ getById: () => Effect.succeed(Option.none()) }),
  ),
  Layer.provide(platform),
);
export const runtime = Reset.layer.pipe(Layer.provideMerge(native));
