import {
  Automation,
  AutomationDefinition,
  AutomationError,
  AutomationIdInput,
  AutomationRun,
  AutomationRunInput,
  AutomationRunsInput,
  AutomationRunsResult,
  AutomationScript,
  AutomationScriptDefinition,
  AutomationScriptIdInput,
  AutomationScriptRunInput,
  AutomationScriptsListInput,
  AutomationScriptsListResult,
  AutomationSetEnabledInput,
  AutomationsListInput,
  AutomationsListResult,
} from "@t3tools/contracts/automations";
import {
  ThreadIssueReferenceInput,
  ThreadIssueLinkResult,
  ThreadIssueUnlinkResult,
  ThreadIssueOperationError,
  NamedAgentError,
  ListNamedAgentsResult,
  ResolveNamedAgentInput,
  HandOverNamedAgentInput,
  NamedAgentThreadResult,
  ProjectIssuesError,
  ProjectIssuesListResult,
  ProjectRequestCreateInput,
  ProjectRequestCreateResult,
  ProjectRequestRef,
  ProjectRequestsListInput,
  ProjectRequestUpdateInput,
  ProjectDashboard,
  ProjectDashboardError,
  ProjectDashboardGetInput,
  ProjectDashboardSetTrackerInput,
  ProjectDashboardSetHealthInput,
  ProjectDashboardSetWidgetsInput,
  ProjectRoadmap,
  ProjectRoadmapError,
  ProjectRoadmapGetInput,
  ProjectRoadmapMoveInput,
  ProjectRoadmapSaveVersionInput,
} from "@t3tools/contracts";
import { NestingRpcs } from "./v2/nesting.js";
import * as Effect from "effect/Effect";
import { ServerSettings as SharedServerSettings } from "@t3tools/contracts/settings";
import {
  ORCHESTRATION_V2_WS_METHODS,
  OrchestrationV2RpcSchemas,
  OrchestrationV2DispatchCommandError,
  OrchestrationV2GetShellSnapshotError,
  OrchestrationV2GetThreadProjectionError,
  OrchestrationV2ThreadLaunchError,
  OrchestrationGetTurnDiffError,
  OrchestrationGetFullThreadDiffError,
  EnvironmentAuthorizationError,
  ProjectMutation,
  ProjectMutationError,
  Project,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Rpc from "effect/unstable/rpc/Rpc";
import * as RpcGroup from "effect/unstable/rpc/RpcGroup";
import { projectShell, threadShell, threadDetail } from "./v2/reads.js";

const OptionalString = Schema.optionalKey(Schema.String);
export const ServerProvider = Schema.Struct({
  provider: OptionalString,
  instanceId: OptionalString,
  driver: OptionalString,
  displayName: OptionalString,
  enabled: Schema.Boolean,
  installed: Schema.Boolean,
  status: Schema.String,
  models: Schema.Array(
    Schema.Struct({
      slug: Schema.String,
      name: OptionalString,
      shortName: OptionalString,
      isCustom: Schema.optionalKey(Schema.Boolean),
    }),
  ),
});
export type ServerProvider = typeof ServerProvider.Type;

export const ServerConfig = Schema.Struct({
  providers: Schema.Array(ServerProvider),
  settings: Schema.Struct({
    subthreadSettleOnComplete: SharedServerSettings.fields.subthreadSettleOnComplete,
    projectSettingsOverrides: Schema.Record(
      Schema.String,
      Schema.Struct({
        subthreadSettleOnComplete: Schema.optionalKey(Schema.Boolean),
      }),
    ).pipe(Schema.withDecodingDefault(Effect.succeed({}))),
  }).pipe(
    Schema.withDecodingDefault(
      Effect.succeed({
        subthreadSettleOnComplete: true,
        projectSettingsOverrides: {},
      }),
    ),
  ),
});

export type ServerConfig = typeof ServerConfig.Type;
export const decodeServerConfig = Schema.decodeUnknownSync(ServerConfig);
export const decodeServerProvider = Schema.decodeUnknownSync(ServerProvider);
export const WS_SERVER_GET_CONFIG_METHOD = "server.getConfig";
export const ClientOrchestrationCommand = OrchestrationV2RpcSchemas.dispatchCommand.input;
export const OrchestrationShellStreamItem = OrchestrationV2RpcSchemas.subscribeShell.output;
export const OrchestrationThreadStreamItem = OrchestrationV2RpcSchemas.subscribeThread.output;
export const decodeShellStreamItem = Schema.decodeUnknownSync(OrchestrationShellStreamItem);
export const decodeThreadStreamItem = Schema.decodeUnknownSync(OrchestrationThreadStreamItem);
export function decodeShellSnapshotItem(input: unknown) {
  const item = decodeShellStreamItem(input);
  if (item.kind !== "snapshot") throw new Error("Expected a V2 shell snapshot.");
  return {
    kind: "snapshot" as const,
    snapshot: {
      snapshotSequence: item.snapshot.snapshotSequence,
      projects: item.snapshot.projects.map(projectShell),
      threads: item.snapshot.threads.map(threadShell),
      updatedAt: new Date().toISOString(),
    },
  };
}
export function decodeThreadSnapshotItem(input: unknown) {
  const item = decodeThreadStreamItem(input);
  if (item.kind !== "snapshot") throw new Error("Expected a V2 thread snapshot.");
  return {
    kind: "snapshot" as const,
    snapshot: { snapshotSequence: item.snapshotSequence, thread: threadDetail(item.projection) },
  };
}
export function decodeThreadShell(input: unknown) {
  return decodeShellSnapshotItem({
    kind: "snapshot",
    snapshot: {
      schemaVersion: 2,
      snapshotSequence: 0,
      projects: [],
      threads: [input],
      archivedThreads: [],
    },
  }).snapshot.threads[0]!;
}
const encodeCommand = Schema.encodeUnknownSync(ClientOrchestrationCommand);
const decodeCommand = Schema.decodeUnknownSync(ClientOrchestrationCommand);
export function encodeClientOrchestrationCommand(input: unknown) {
  return encodeCommand(decodeCommand(input));
}
const schema = OrchestrationV2RpcSchemas;
const namedAgentRpcs = [
  Rpc.make("orchestration.listNamedAgents", {
    payload: Schema.Struct({}),
    success: ListNamedAgentsResult,
    error: Schema.Union([NamedAgentError, EnvironmentAuthorizationError]),
  }),
  Rpc.make("orchestration.resolveNamedAgent", {
    payload: ResolveNamedAgentInput,
    success: NamedAgentThreadResult,
    error: Schema.Union([NamedAgentError, EnvironmentAuthorizationError]),
  }),
  Rpc.make("orchestration.handOverNamedAgent", {
    payload: HandOverNamedAgentInput,
    success: NamedAgentThreadResult,
    error: Schema.Union([NamedAgentError, EnvironmentAuthorizationError]),
  }),
];
// Scripts and automation rules (apps/server/src/automations).
const automationError = Schema.Union([AutomationError, EnvironmentAuthorizationError]);
const WsAutomationsListRpc = Rpc.make("automations.list", {
  payload: AutomationsListInput,
  success: AutomationsListResult,
  error: automationError,
});
const WsAutomationsSaveRpc = Rpc.make("automations.save", {
  payload: AutomationDefinition,
  success: Automation,
  error: automationError,
});
const WsAutomationsRemoveRpc = Rpc.make("automations.remove", {
  payload: AutomationIdInput,
  success: Schema.Void,
  error: automationError,
});
const WsAutomationsSetEnabledRpc = Rpc.make("automations.setEnabled", {
  payload: AutomationSetEnabledInput,
  success: Automation,
  error: automationError,
});
const WsAutomationsRunRpc = Rpc.make("automations.run", {
  payload: AutomationRunInput,
  success: AutomationRun,
  error: automationError,
});
const WsAutomationsRunsRpc = Rpc.make("automations.runs", {
  payload: AutomationRunsInput,
  success: AutomationRunsResult,
  error: automationError,
});
const WsAutomationScriptsListRpc = Rpc.make("automationScripts.list", {
  payload: AutomationScriptsListInput,
  success: AutomationScriptsListResult,
  error: automationError,
});
const WsAutomationScriptsSaveRpc = Rpc.make("automationScripts.save", {
  payload: AutomationScriptDefinition,
  success: AutomationScript,
  error: automationError,
});
const WsAutomationScriptsRemoveRpc = Rpc.make("automationScripts.remove", {
  payload: AutomationScriptIdInput,
  success: Schema.Void,
  error: automationError,
});
const WsAutomationScriptsRunRpc = Rpc.make("automationScripts.run", {
  payload: AutomationScriptRunInput,
  success: AutomationRun,
  error: automationError,
});

export const WsRpcGroup = RpcGroup.make(
  WsAutomationsListRpc,
  WsAutomationsSaveRpc,
  WsAutomationsRemoveRpc,
  WsAutomationsSetEnabledRpc,
  WsAutomationsRunRpc,
  WsAutomationsRunsRpc,
  WsAutomationScriptsListRpc,
  WsAutomationScriptsSaveRpc,
  WsAutomationScriptsRemoveRpc,
  WsAutomationScriptsRunRpc,
  ...namedAgentRpcs,
  ...NestingRpcs,
  Rpc.make("threadIssues.link", {
    payload: ThreadIssueReferenceInput,
    success: ThreadIssueLinkResult,
    error: Schema.Union([ThreadIssueOperationError, EnvironmentAuthorizationError]),
  }),
  Rpc.make("threadIssues.unlink", {
    payload: ThreadIssueReferenceInput,
    success: ThreadIssueUnlinkResult,
    error: Schema.Union([ThreadIssueOperationError, EnvironmentAuthorizationError]),
  }),
  Rpc.make(WS_SERVER_GET_CONFIG_METHOD, {
    payload: Schema.Struct({}),
    success: ServerConfig,
    error: EnvironmentAuthorizationError,
  }),
  Rpc.make("projects.mutate", {
    payload: ProjectMutation,
    success: Project,
    error: Schema.Union([ProjectMutationError, EnvironmentAuthorizationError]),
  }),
  Rpc.make(ORCHESTRATION_V2_WS_METHODS.dispatchCommand, {
    payload: schema.dispatchCommand.input,
    success: schema.dispatchCommand.output,
    error: Schema.Union([OrchestrationV2DispatchCommandError, EnvironmentAuthorizationError]),
  }),
  Rpc.make(ORCHESTRATION_V2_WS_METHODS.launchThread, {
    payload: schema.launchThread.input,
    success: schema.launchThread.output,
    error: Schema.Union([OrchestrationV2ThreadLaunchError, EnvironmentAuthorizationError]),
  }),
  Rpc.make(ORCHESTRATION_V2_WS_METHODS.getTurnDiff, {
    payload: schema.getTurnDiff.input,
    success: schema.getTurnDiff.output,
    error: Schema.Union([OrchestrationGetTurnDiffError, EnvironmentAuthorizationError]),
  }),
  Rpc.make(ORCHESTRATION_V2_WS_METHODS.getFullThreadDiff, {
    payload: schema.getFullThreadDiff.input,
    success: schema.getFullThreadDiff.output,
    error: Schema.Union([OrchestrationGetFullThreadDiffError, EnvironmentAuthorizationError]),
  }),
  Rpc.make(ORCHESTRATION_V2_WS_METHODS.getThreadProjection, {
    payload: schema.getThreadProjection.input,
    success: schema.getThreadProjection.output,
    error: Schema.Union([OrchestrationV2GetThreadProjectionError, EnvironmentAuthorizationError]),
  }),
  Rpc.make(ORCHESTRATION_V2_WS_METHODS.getArchivedShellSnapshot, {
    payload: schema.getArchivedShellSnapshot.input,
    success: schema.getArchivedShellSnapshot.output,
    error: Schema.Union([OrchestrationV2GetShellSnapshotError, EnvironmentAuthorizationError]),
  }),
  Rpc.make(ORCHESTRATION_V2_WS_METHODS.subscribeShell, {
    payload: schema.subscribeShell.input,
    success: schema.subscribeShell.output,
    stream: true,
    error: Schema.Union([OrchestrationV2GetShellSnapshotError, EnvironmentAuthorizationError]),
  }),
  Rpc.make(ORCHESTRATION_V2_WS_METHODS.subscribeThread, {
    payload: schema.subscribeThread.input,
    success: schema.subscribeThread.output,
    stream: true,
    error: Schema.Union([OrchestrationV2GetThreadProjectionError, EnvironmentAuthorizationError]),
  }),
  Rpc.make("projectRequests.create", {
    payload: ProjectRequestCreateInput,
    success: ProjectRequestCreateResult,
    error: Schema.Union([ProjectIssuesError, EnvironmentAuthorizationError]),
  }),
  Rpc.make("projectRequests.update", {
    payload: ProjectRequestUpdateInput,
    success: ProjectRequestRef,
    error: Schema.Union([ProjectIssuesError, EnvironmentAuthorizationError]),
  }),
  Rpc.make("projectRequests.list", {
    payload: ProjectRequestsListInput,
    success: ProjectIssuesListResult,
    error: Schema.Union([ProjectIssuesError, EnvironmentAuthorizationError]),
  }),
  Rpc.make("projectDashboard.get", {
    payload: ProjectDashboardGetInput,
    success: ProjectDashboard,
    error: Schema.Union([ProjectDashboardError, EnvironmentAuthorizationError]),
  }),
  Rpc.make("projectDashboard.setWidgets", {
    payload: ProjectDashboardSetWidgetsInput,
    success: ProjectDashboard,
    error: Schema.Union([ProjectDashboardError, EnvironmentAuthorizationError]),
  }),
  Rpc.make("projectDashboard.setTracker", {
    payload: ProjectDashboardSetTrackerInput,
    success: ProjectDashboard,
    error: Schema.Union([ProjectDashboardError, EnvironmentAuthorizationError]),
  }),
  Rpc.make("projectDashboard.setHealth", {
    payload: ProjectDashboardSetHealthInput,
    success: ProjectDashboard,
    error: Schema.Union([ProjectDashboardError, EnvironmentAuthorizationError]),
  }),
  Rpc.make("projectRoadmap.get", {
    payload: ProjectRoadmapGetInput,
    success: ProjectRoadmap,
    error: Schema.Union([ProjectRoadmapError, EnvironmentAuthorizationError]),
  }),
  Rpc.make("projectRoadmap.move", {
    payload: ProjectRoadmapMoveInput,
    success: ProjectRoadmap,
    error: Schema.Union([ProjectRoadmapError, EnvironmentAuthorizationError]),
  }),
  Rpc.make("projectRoadmap.saveVersion", {
    payload: ProjectRoadmapSaveVersionInput,
    success: ProjectRoadmap,
    error: Schema.Union([ProjectRoadmapError, EnvironmentAuthorizationError]),
  }),
);
