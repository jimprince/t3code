import {
  McpCapabilityUnavailableError,
  OrchestratorMcpFailure,
  NonNegativeInt,
  ProjectLayout,
  ProjectLayoutError,
  ProjectLayoutHistoryEntry,
  ProjectLayoutOp,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Tool from "effect/ai/Tool";
import * as Toolkit from "effect/ai/Toolkit";

import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  ThreadManagement.ThreadManagementService,
];
const failure = Schema.Union([
  McpCapabilityUnavailableError,
  ProjectLayoutError,
  OrchestratorMcpFailure,
]);

const WidgetTypeInfo = Schema.Struct({
  type: Schema.String,
  title: Schema.String,
  description: Schema.String,
  fields: Schema.Array(
    Schema.Struct({
      key: Schema.String,
      kind: Schema.String,
      label: Schema.String,
      description: Schema.String,
      default: Schema.optionalKey(Schema.Unknown),
      min: Schema.optionalKey(Schema.Number),
      max: Schema.optionalKey(Schema.Number),
      required: Schema.optionalKey(Schema.Boolean),
    }),
  ),
});

const GetProjectLayoutTool = Tool.make("project_layout_get", {
  description:
    "Read this project's page layout (tabs of widgets shown to Brad in every T3 client) and the catalogue of widget types you can add, with their settings. Call it before project_layout_update and pass its revision as baseRevision.",
  success: Schema.Struct({
    revision: NonNegativeInt,
    layout: ProjectLayout,
    widgetTypes: Schema.Array(WidgetTypeInfo),
  }),
  failure,
  dependencies,
})
  .annotate(Tool.Title, "Get project layout")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const UpdateProjectLayoutTool = Tool.make("project_layout_update", {
  description:
    'Change this project\'s page layout when Brad asks (add, remove, rename or reorder tabs; add, remove, move, retitle, resize or configure widgets). Only the project\'s orchestrator can do this. Ops address tabs and widgets by id and apply in order on top of the current layout; if one fails nothing changes and the error carries the current layout. The change shows in every client at once with an Undo chip naming you and your reason, so always give a short reason. Example: {"op":"setWidgetConfig","widgetId":"requests","config":{"includeLater":false}}.',
  parameters: Schema.Struct({
    baseRevision: NonNegativeInt.annotate({
      description: "The revision you read with project_layout_get.",
    }),
    ops: Schema.Array(ProjectLayoutOp),
    reason: Schema.String.annotate({
      description: "One short line for Brad, for example: Added a Roadmap tab as asked.",
    }),
  }),
  success: Schema.Struct({ layout: ProjectLayout }),
  failure,
  dependencies,
})
  .annotate(Tool.Title, "Update project layout")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false);

const ProjectLayoutHistoryTool = Tool.make("project_layout_history", {
  description: "List recent revisions of this project's layout: who changed it, when and why.",
  parameters: Schema.Struct({ limit: Schema.optionalKey(NonNegativeInt) }),
  success: Schema.Struct({ entries: Schema.Array(ProjectLayoutHistoryEntry) }),
  failure,
  dependencies,
})
  .annotate(Tool.Title, "Project layout history")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const RevertProjectLayoutTool = Tool.make("project_layout_revert", {
  description:
    "Restore an earlier revision of this project's layout as a new revision (0 is the default layout). Only the project's orchestrator can do this.",
  parameters: Schema.Struct({ revision: NonNegativeInt }),
  success: Schema.Struct({ layout: ProjectLayout }),
  failure,
  dependencies,
})
  .annotate(Tool.Title, "Revert project layout")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false);

export const ProjectLayoutToolkit = Toolkit.make(
  GetProjectLayoutTool,
  UpdateProjectLayoutTool,
  ProjectLayoutHistoryTool,
  RevertProjectLayoutTool,
);
