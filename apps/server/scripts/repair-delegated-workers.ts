/* oxlint-disable t3code/no-global-process-runtime -- Standalone offline operator entry. */
// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalConsole:off
import * as NodeFSP from "node:fs/promises";
import * as NodeChildProcess from "node:child_process";
import * as NodeUtil from "node:util";
import * as NodeSqlite from "node:sqlite";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as DateTime from "effect/DateTime";
import { listMetadata } from "../src/forkThreads/MetadataStore.ts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as EventStore from "../src/orchestration-v2/EventStore.ts";
import * as EventSink from "../src/orchestration-v2/EventSink.ts";
import * as ProjectionStore from "../src/orchestration-v2/ProjectionStore.ts";
import * as DelegatedWorkerRepair from "../src/forkThreads/DelegatedWorkerRepair.ts";

const { values } = NodeUtil.parseArgs({
  options: {
    database: { type: "string" },
    apply: { type: "boolean", default: false },
    offline: { type: "boolean", default: false },
  },
});
if (!values.database)
  throw new Error(
    "Usage: node apps/server/scripts/repair-delegated-workers.ts --database <statev2.sqlite> [--apply --offline]",
  );
const databasePath = await NodeFSP.realpath(values.database);
if (values.apply) {
  if (!values.offline) throw new Error("--apply requires --offline: stop the owning server first.");
  if (process.platform === "darwin") {
    const opened = NodeChildProcess.spawnSync("/usr/sbin/lsof", ["-t", "--", databasePath], {
      encoding: "utf8",
    });
    if (opened.error || (opened.status !== 0 && opened.status !== 1))
      throw new Error("Cannot verify offline database ownership with lsof.");
    if (opened.stdout.trim())
      throw new Error(
        `Database is open in process(es) ${opened.stdout.trim()}; stop its owner before applying.`,
      );
  } else if (process.platform !== "linux")
    throw new Error("Offline apply requires Linux or macOS to verify database ownership.");
  if (process.platform === "linux") {
    const target = await NodeFSP.stat(databasePath);
    for (const pid of await NodeFSP.readdir("/proc")) {
      if (!/^\d+$/.test(pid) || pid === String(process.pid)) continue;
      let fds: string[];
      try {
        fds = await NodeFSP.readdir(`/proc/${pid}/fd`);
      } catch {
        continue;
      }
      for (const fd of fds) {
        const stat = await NodeFSP.stat(`/proc/${pid}/fd/${fd}`).catch(() => null);
        if (stat?.dev === target.dev && stat.ino === target.ino)
          throw new Error(`Database is open in process ${pid}; stop its owner before applying.`);
      }
    }
  }
}
// Only VACUUM INTO touches the source, through SQLite's read-only snapshot path.
// Repair layers may initialize ancillary tables, so dry-run builds them only on the copy.
let directory: string | undefined;
try {
  let repairPath = databasePath;
  if (!values.apply) {
    directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-delegated-repair-"));
    repairPath = NodePath.join(directory, "statev2.sqlite");
    const source = new NodeSqlite.DatabaseSync(databasePath, { readOnly: true });
    try {
      source.prepare("VACUUM INTO ?").run(repairPath);
    } finally {
      source.close();
    }
  }
  const database = NodeSqliteClient.layer({ filename: repairPath });
  const stores = Layer.mergeAll(EventStore.layer, ProjectionStore.layer);
  const runtime = EventSink.layer.pipe(Layer.provideMerge(stores), Layer.provideMerge(database));
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const store = yield* ProjectionStore.ProjectionStoreV2;
      const repair = yield* DelegatedWorkerRepair.DelegatedWorkerRepair;
      const outcome = yield* repair.apply();
      if (values.apply) return outcome;
      const organization = new Map((yield* listMetadata(sql)).map((row) => [row.threadId, row]));
      const changes = [];
      // Report the actual before/after repair diff on the private copy, not merely its plan.
      for (const planned of outcome.changes) {
        const thread = yield* store.getThread(planned.threadId);
        const fields = planned.fields.flatMap((change) => {
          const value = thread[change.field];
          const after = DateTime.isDateTime(value) ? DateTime.formatIso(value) : (value ?? null);
          return change.before === after ? [] : [{ ...change, after }];
        });
        const metadata = organization.get(planned.threadId);
        const changedOrganization =
          planned.organization && metadata
            ? { before: planned.organization.before, after: metadata }
            : null;
        if (fields.length || changedOrganization)
          changes.push({ ...planned, organization: changedOrganization, fields });
      }
      const { applied, ...manifest } = outcome;
      return { ...manifest, changes, wouldApply: applied };
    }).pipe(Effect.provide(DelegatedWorkerRepair.layer.pipe(Layer.provideMerge(runtime)))),
  );
  console.log(
    JSON.stringify(
      { mode: values.apply ? "applied" : "dry-run", database: databasePath, ...result },
      null,
      2,
    ),
  );
} finally {
  if (directory) await NodeFSP.rm(directory, { recursive: true, force: true });
}
