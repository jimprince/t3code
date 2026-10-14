import { ThreadFilePlan } from "./orchestrationV2.ts";
import { ProjectRequestPlacer } from "./projectIssues.ts";
import * as Schema from "effect/Schema";
import { IsoDateTime, NonNegativeInt, ThreadId } from "./baseSchemas.ts";

export const DashboardSource = Schema.Struct({
  id: Schema.String,
  detail: Schema.optionalKey(Schema.NullOr(Schema.String)),
  kind: Schema.Literals(["local", "gitea", "plan", "release"]),
  observedAt: IsoDateTime,
  lastSuccessAt: Schema.NullOr(IsoDateTime),
  staleAfterMs: NonNegativeInt,
  coverage: Schema.Literals(["complete", "bounded", "unavailable"]),
  failed: Schema.Boolean,
});
export type DashboardSource = typeof DashboardSource.Type;
export const DashboardProgress = Schema.Struct({
  done: NonNegativeInt,
  total: NonNegativeInt,
  planVersion: Schema.String,
  sourceId: Schema.String,
  confirmedAt: IsoDateTime,
  confirmationKnown: Schema.optionalKey(Schema.Boolean),
});
export type DashboardProgress = typeof DashboardProgress.Type;
export const DashboardMovement = Schema.Struct({
  state: Schema.Literals(["measured", "unknown", "replanned"]),
  doneDelta: Schema.NullOr(Schema.Int),
  windowMs: NonNegativeInt,
  fromAt: Schema.NullOr(IsoDateTime),
  toAt: IsoDateTime,
});
export type DashboardMovement = typeof DashboardMovement.Type;
export const DashboardTask = Schema.Struct({
  membershipWarnings: Schema.optionalKey(Schema.Array(Schema.String)),
  id: Schema.String,
  sourceId: Schema.String,
  title: Schema.String,
  url: Schema.NullOr(Schema.String),
  threadId: Schema.NullOr(ThreadId),
  workstreamId: Schema.String,
  rank: Schema.optionalKey(Schema.NullOr(Schema.Number)),
  createdAt: Schema.optionalKey(IsoDateTime),
  placedBy: Schema.optionalKey(Schema.NullOr(ProjectRequestPlacer)),
  partOf: Schema.optionalKey(Schema.NullOr(Schema.Number)),
  /** Present only on asks: a question is answered, not ordered; any other ask is a task. */
  kind: Schema.optionalKey(Schema.Literals(["task", "question"])),
  /** The `bug` tag; absent when untagged. */
  bug: Schema.optionalKey(Schema.Boolean),
  /** Saved for Later: out of the order and out of New, counted on its own. */
  parked: Schema.optionalKey(Schema.Boolean),
  closedAt: Schema.NullOr(IsoDateTime),
  status: Schema.Literals(["pending", "working", "blocked", "review", "done"]),
  progress: Schema.NullOr(DashboardProgress),
  movement: DashboardMovement,
  forecast: Schema.NullOr(
    Schema.Struct({
      eta: IsoDateTime,
      precision: Schema.optionalKey(Schema.Literals(["date", "instant"])),
      basis: Schema.Literal("owner"),
      sourceId: Schema.String,
    }),
  ),
  nextStep: Schema.NullOr(Schema.String),
  attentionIds: Schema.Array(Schema.String),
  hasChecklist: Schema.optionalKey(Schema.Boolean),
});
export type DashboardTask = typeof DashboardTask.Type;
export const DashboardAttention = Schema.Struct({
  id: Schema.String,
  taskId: Schema.String,
  blockingTaskIds: Schema.Array(Schema.String),
  requestId: Schema.NullOr(Schema.String),
  title: Schema.String,
  kind: Schema.Literals(["decision", "question", "approval", "review", "test"]),
  canRespond: Schema.Boolean,
  options: Schema.Array(Schema.Struct({ text: Schema.String, recommended: Schema.Boolean })),
  priority: NonNegativeInt,
  url: Schema.NullOr(Schema.String),
  threadId: Schema.NullOr(ThreadId),
  updatedAt: IsoDateTime,
  deadline: Schema.NullOr(Schema.String),
  question: Schema.String,
  sourceId: Schema.String,
});
export type DashboardAttention = typeof DashboardAttention.Type;
export const DashboardWorkstream = Schema.Struct({
  membershipWarnings: Schema.optionalKey(Schema.Array(Schema.String)),
  url: Schema.optionalKey(Schema.NullOr(Schema.String)),
  threadId: Schema.optionalKey(Schema.NullOr(ThreadId)),
  progress: Schema.optionalKey(Schema.NullOr(DashboardProgress)),
  childIssueIds: Schema.optionalKey(Schema.Array(Schema.String)),
  unknownChildIds: Schema.optionalKey(Schema.Array(Schema.String)),
  parentWorkstreamId: Schema.optionalKey(Schema.NullOr(Schema.String)),
  rank: Schema.optionalKey(Schema.NullOr(Schema.Number)),
  createdAt: Schema.optionalKey(IsoDateTime),
  placedBy: Schema.optionalKey(Schema.NullOr(ProjectRequestPlacer)),
  id: Schema.String,
  title: Schema.String,
  taskIds: Schema.Array(Schema.String),
});
export type DashboardWorkstream = typeof DashboardWorkstream.Type;
export const DashboardProject = Schema.Struct({
  planSource: Schema.optionalKey(Schema.Literals(["tracker", "briefing"])),
  planMigration: Schema.optionalKey(
    Schema.Struct({
      observedAt: IsoDateTime,
      removedTaskIds: Schema.Array(Schema.String),
    }),
  ),
  id: Schema.String,
  rootThreadId: Schema.NullOr(ThreadId),
  parentId: Schema.NullOr(Schema.String),
  title: Schema.String,
  utility: Schema.Boolean,
  omittedTaskCount: NonNegativeInt,
  omittedWorkstreamCount: Schema.optionalKey(NonNegativeInt),
  workstreams: Schema.Array(DashboardWorkstream),
  tasks: Schema.Array(DashboardTask),
  attention: Schema.Array(DashboardAttention),
  sourceIds: Schema.Array(Schema.String),
});
export type DashboardProject = typeof DashboardProject.Type;
export const DashboardRelease = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  taskId: Schema.NullOr(Schema.String),
  installedVersion: Schema.NullOr(Schema.String),
  latestVersion: Schema.NullOr(Schema.String),
  sourceId: Schema.String,
  phase: Schema.optionalKey(Schema.NullOr(Schema.String)),
  eta: Schema.optionalKey(Schema.NullOr(IsoDateTime)),
  upstreamNightly: Schema.optionalKey(Schema.NullOr(Schema.String)),
  nightlyLagDays: Schema.optionalKey(Schema.NullOr(Schema.Number)),
  nightlySync: Schema.optionalKey(Schema.NullOr(Schema.String)),
});
export type DashboardRelease = typeof DashboardRelease.Type;
/** One compact environment-local document. Environment identity comes from the authenticated connection. */
export const DashboardSnapshot = Schema.Struct({
  planMigration: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        kind: Schema.Literal("unbound-briefing-file"),
        fileName: Schema.String,
        reason: Schema.String,
      }),
    ),
  ),
  filePlans: Schema.optionalKey(Schema.Record(Schema.String, ThreadFilePlan)),
  revision: NonNegativeInt,
  asOf: IsoDateTime,
  projects: Schema.Array(DashboardProject),
  releases: Schema.Array(DashboardRelease),
  sources: Schema.Array(DashboardSource),
});
export type DashboardSnapshot = typeof DashboardSnapshot.Type;
export const DashboardSubscribeInput = Schema.Struct({
  afterRevision: Schema.optionalKey(NonNegativeInt),
});
