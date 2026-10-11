import * as Schema from "effect/Schema";
import { Rpc } from "effect/unstable/rpc";
import { EnvironmentId, IsoDateTime, ProjectId, ThreadId } from "./baseSchemas.ts";
import { EnvironmentAuthorizationError } from "./auth.ts";

const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
export const HarnessSnapshotInput = Schema.Struct({
  projectIds: Schema.optionalKey(Schema.Array(ProjectId).check(Schema.isMaxLength(100))),
  routineKeys: Schema.optionalKey(Schema.Array(Schema.String).check(Schema.isMaxLength(100))),
  historyLimit: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 50 }))),
});
export type HarnessSnapshotInput = typeof HarnessSnapshotInput.Type;
export const HarnessThreadLink = Schema.Struct({
  environmentId: EnvironmentId,
  threadId: ThreadId,
  runId: Schema.NullOr(Schema.String),
  messageId: Schema.NullOr(Schema.String),
  href: Schema.String,
});
export type HarnessThreadLink = typeof HarnessThreadLink.Type;
export const HarnessRun = Schema.Struct({
  key: Schema.String,
  expectedAt: Schema.NullOr(IsoDateTime),
  requestedAt: IsoDateTime,
  startedAt: Schema.NullOr(IsoDateTime),
  finishedAt: Schema.NullOr(IsoDateTime),
  outcome: Schema.Literals([
    "queued",
    "running",
    "completed",
    "failed",
    "interrupted",
    "cancelled",
    "skipped",
    "unknown",
  ]),
  outcomeKind: Schema.Literals(["dispatch", "execution", "observation"]),
  dryRun: Schema.Boolean,
  // Findings caught are distinct from runtime failures. Null means unknown, never zero.
  errorCount: Schema.NullOr(Count),
  runtimeErrorCount: Schema.NullOr(Count),
  evidence: Schema.String,
  threads: Schema.Array(HarnessThreadLink),
});
export type HarnessRun = typeof HarnessRun.Type;
export const HarnessLateness = Schema.Struct({
  phase: Schema.optionalKey(Schema.Literals(["dispatch", "start", "none", "unknown"])),
  state: Schema.Literals(["on-time", "overdue", "disabled", "event-driven", "unknown"]),
  overdue: Schema.NullOr(Schema.Boolean),
  since: Schema.NullOr(IsoDateTime),
  latenessMs: Schema.NullOr(Count),
  graceMs: Count,
  missedSlots: Schema.NullOr(Count),
  sampleSize: Count,
  coverage: Schema.Literals(["bounded", "complete", "unknown"]),
  evidence: Schema.String,
});
export type HarnessLateness = typeof HarnessLateness.Type;
export const HarnessTrend = Schema.Struct({
  sampleSize: Count,
  knownSamples: Count,
  missingSamples: Count,
  average: Schema.NullOr(Schema.Number),
  recent: Schema.Array(Schema.NullOr(Count)),
});
export type HarnessTrend = typeof HarnessTrend.Type;
export const HarnessSource = Schema.Struct({
  key: Schema.String,
  readAt: IsoDateTime,
  observedAt: Schema.NullOr(IsoDateTime),
  status: Schema.Literals(["available", "stale", "unavailable", "not-configured", "refused"]),
  evidence: Schema.String,
});
export type HarnessSource = typeof HarnessSource.Type;
export const HarnessRoutine = Schema.Struct({
  key: Schema.String,
  agentKey: Schema.NullOr(Schema.String),
  name: Schema.String,
  whatItChecks: Schema.NullOr(Schema.String),
  environmentId: EnvironmentId,
  projectId: Schema.NullOr(ProjectId),
  owner: Schema.NullOr(HarnessThreadLink),
  purpose: Schema.Literals(["harness", "unclassified"]),
  source: Schema.String,
  sourceStale: Schema.Boolean,
  state: Schema.Literals(["enabled", "disabled", "failing", "unknown", "not shown yet"]),
  lifecycle: Schema.NullOr(Schema.Literals(["standing", "conditional"])),
  context: Schema.NullOr(Schema.Literals(["persistent", "new-instance-per-run"])),
  scheduleOrTrigger: Schema.String,
  nextExpectedRun: Schema.NullOr(IsoDateTime),
  lateness: HarnessLateness,
  liveness: Schema.Literals(["active", "not currently live", "unknown"]),
  lastRun: Schema.NullOr(HarnessRun),
  lastDispatch: Schema.optionalKey(Schema.NullOr(HarnessRun)),
  activeRuns: Schema.Array(HarnessRun),
  history: Schema.Array(HarnessRun),
  historyCoverage: Schema.Struct({
    retainedFrom: Schema.NullOr(IsoDateTime),
    truncated: Schema.Boolean,
    evidence: Schema.String,
  }),
  errorsPerRun: HarnessTrend,
  runtimeErrorsPerRun: HarnessTrend,
  failedExecutions: Schema.Struct({
    sampleSize: Count,
    failures: Count,
    rate: Schema.NullOr(Schema.Number),
  }),
  latestOutput: Schema.NullOr(HarnessThreadLink),
  observations: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        key: Schema.String,
        state: Schema.String,
        observedAt: Schema.NullOr(IsoDateTime),
        evidence: Schema.String,
      }),
    ).check(Schema.isMaxLength(100)),
  ),
});
export type HarnessRoutine = typeof HarnessRoutine.Type;
export const HarnessAgent = Schema.Struct({
  key: Schema.String,
  name: Schema.String,
  environmentId: EnvironmentId,
  lifecycle: Schema.NullOr(Schema.Literals(["standing", "conditional"])),
  context: Schema.NullOr(Schema.Literals(["persistent", "new-instance-per-run"])),
  thread: Schema.NullOr(HarnessThreadLink),
  routineKeys: Schema.Array(Schema.String),
  liveness: Schema.Literals(["active", "not currently live", "unknown"]),
});
export type HarnessAgent = typeof HarnessAgent.Type;
export const HarnessSnapshot = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  environmentId: EnvironmentId,
  generatedAt: IsoDateTime,
  sources: Schema.Array(HarnessSource),
  agents: Schema.Array(HarnessAgent),
  routines: Schema.Array(HarnessRoutine),
});
export type HarnessSnapshot = typeof HarnessSnapshot.Type;
export class HarnessReadError extends Schema.TaggedError<HarnessReadError>()("HarnessReadError", {
  message: Schema.String,
}) {}
export const HarnessSnapshotRpc = Rpc.make("harness.snapshot", {
  payload: HarnessSnapshotInput,
  success: HarnessSnapshot,
  error: Schema.Union([HarnessReadError, EnvironmentAuthorizationError]),
});
