import { DashboardSnapshot, ProjectIssue } from "@t3tools/contracts";
import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as ServerConfig from "../config.ts";

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
});
type StoredDashboard = typeof StoredDashboard.Type;
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
    return yield* fs
      .readFileString(filePath)
      .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(StoredDashboard))));
  }).pipe(Effect.mapError((cause) => new DashboardStoreError({ operation: "read", cause })));
  const write = (value: StoredDashboard) =>
    writeFileStringAtomically({ filePath, contents: JSON.stringify(value) }).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
      Effect.mapError((cause) => new DashboardStoreError({ operation: "write", cause })),
    );
  return DashboardStore.of({ read, write });
});
export const layer = Layer.effect(DashboardStore, make);
