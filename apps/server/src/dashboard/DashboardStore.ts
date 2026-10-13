import * as DateTime from "effect/DateTime";
import { DashboardSnapshot, ProjectIssue } from "@t3tools/contracts";
import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as ServerConfig from "../config.ts";

import { issueId } from "./dashboard.logic.ts";
import { BriefingPlan } from "./aggregation.ts";

const ProgressSample = Schema.Struct({
  taskId: Schema.String,
  at: Schema.String,
  done: Schema.Number,
  total: Schema.Number,
  planVersion: Schema.String,
});
const StoredDashboard = Schema.Struct({
  snapshot: DashboardSnapshot,
  samples: Schema.Array(ProgressSample),
  issues: Schema.optionalKey(Schema.Record(Schema.String, Schema.Array(ProjectIssue))),
  plans: Schema.optionalKey(Schema.Array(BriefingPlan)),
  rootRepositories: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
});
type StoredDashboard = typeof StoredDashboard.Type;
const CompactStoredDashboard = Schema.Struct({
  snapshot: DashboardSnapshot,
  samples: Schema.Array(
    Schema.Tuple([Schema.String, Schema.Number, Schema.Number, Schema.Number, Schema.String]),
  ),
  issueRepositories: Schema.Record(Schema.String, Schema.Array(ProjectIssue)),
  issueRoots: Schema.Record(Schema.String, Schema.Array(Schema.String)),
  plans: Schema.Array(BriefingPlan),
  rootRepositories: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
});
/** Keep one slim issue per repository and numeric progress tuples on disk. Old caches still read. */
export function compactStoredDashboard(value: StoredDashboard): typeof CompactStoredDashboard.Type {
  const repositories: Record<string, ProjectIssue[]> = {};
  const roots: Record<string, string[]> = {};
  const rows = new Map<string, ProjectIssue>();
  for (const [root, issues] of Object.entries(value.issues ?? {})) {
    roots[root] = issues.map((i) => issueId(i.host, i.repository, i.number));
    for (const issue of issues) {
      const id = issueId(issue.host, issue.repository, issue.number);
      const old = rows.get(id);
      const { answer: _answer, ...summary } = issue;
      rows.set(id, {
        ...summary,
        requestSource: null,
        assignees: [],
        comments: 0,
        latestComment: null,
        linkedThreadIds: [...new Set([...(old?.linkedThreadIds ?? []), ...issue.linkedThreadIds])],
        ...(issue.decision
          ? { decision: { ...issue.decision, context: issue.decision.context.slice(0, 1500) } }
          : {}),
      });
    }
  }
  for (const issue of rows.values()) {
    const key = `${issue.host}/${issue.repository}`;
    (repositories[key] ??= []).push(issue);
  }
  return {
    snapshot: value.snapshot,
    samples: value.samples.map((s) => [s.taskId, Date.parse(s.at), s.done, s.total, s.planVersion]),
    issueRepositories: repositories,
    issueRoots: roots,
    plans: value.plans ?? [],
    rootRepositories: value.rootRepositories ?? {},
  };
}
export function expandStoredDashboard(value: typeof CompactStoredDashboard.Type): StoredDashboard {
  const rows = new Map(
    Object.values(value.issueRepositories)
      .flat()
      .map((i) => [issueId(i.host, i.repository, i.number), i]),
  );
  return {
    snapshot: value.snapshot,
    samples: value.samples.map(([taskId, at, done, total, planVersion]) => ({
      taskId,
      at: DateTime.formatIso(DateTime.makeUnsafe(at)),
      done,
      total,
      planVersion,
    })),
    issues: Object.fromEntries(
      Object.entries(value.issueRoots).map(([root, ids]) => [
        root,
        ids.flatMap((id) => (rows.has(id) ? [rows.get(id)!] : [])),
      ]),
    ),
    plans: value.plans,
    rootRepositories: value.rootRepositories ?? {},
  };
}
export class DashboardStoreError extends Schema.TaggedError<DashboardStoreError>()(
  "DashboardStoreError",
  { operation: Schema.Literals(["read", "write"]), cause: Schema.Defect() },
) {}
export class DashboardStore extends Context.Service<
  DashboardStore,
  {
    readonly read: Effect.Effect<StoredDashboard | null, DashboardStoreError>;
    readonly write: (value: StoredDashboard) => Effect.Effect<void, DashboardStoreError>;
  }
>()("t3/dashboard/DashboardStore") {}
const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const filePath = path.join(config.stateDir, "dashboard-snapshot.json");
  const read = Effect.gen(function* () {
    if (!(yield* fs.exists(filePath))) return null;
    return yield* fs.readFileString(filePath).pipe(
      Effect.flatMap(
        Schema.decodeUnknownEffect(
          Schema.fromJsonString(Schema.Union([CompactStoredDashboard, StoredDashboard])),
        ),
      ),
      Effect.map((value) => ("issueRepositories" in value ? expandStoredDashboard(value) : value)),
    );
  }).pipe(Effect.mapError((cause) => new DashboardStoreError({ operation: "read", cause })));
  const write = (value: StoredDashboard) =>
    writeFileStringAtomically({
      filePath,
      contents: JSON.stringify(compactStoredDashboard(value)),
    }).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
      Effect.mapError((cause) => new DashboardStoreError({ operation: "write", cause })),
    );
  return DashboardStore.of({ read, write });
});
export const layer = Layer.effect(DashboardStore, make);
