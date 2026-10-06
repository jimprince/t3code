// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalConsole:off
import * as NodeFSP from "node:fs/promises";
import * as NodeUtil from "node:util";
import * as NodeSqlite from "node:sqlite";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Option from "effect/Option";
import * as ServerConfig from "../config.ts";
import { resolveBaseDir } from "../os-jank.ts";
import { readPersistedServerRuntimeState } from "../serverRuntimeState.ts";
import { verifyRepairOffline } from "./repairOffline.ts";
import * as DateTime from "effect/DateTime";
import { listMetadata } from "../forkThreads/MetadataStore.ts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as EventStore from "../orchestration-v2/EventStore.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as DelegatedWorkerRepair from "../forkThreads/DelegatedWorkerRepair.ts";

export async function runRepairDelegatedWorkers(args: string[]): Promise<void> {
  const { values } = NodeUtil.parseArgs({
    args,
    options: {
      database: { type: "string" },
      "base-dir": { type: "string" },
      "home-dir": { type: "string" },
      port: { type: "string" },
      apply: { type: "boolean", default: false },
      offline: { type: "boolean", default: false },
      "dry-run": { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
  });
  if (values.help) {
    console.log(
      "Usage: t3 repair-delegated-workers [--base-dir <home> | --database <V2 DB>] [--port <configured-port>] [--dry-run | --apply --offline]. Dry-run is the default; apply requires a held maintenance window and verified offline ownership.",
    );
    return;
  }
  if (values.apply && values["dry-run"]) throw new Error("Choose --dry-run or --apply, not both.");
  if (values["base-dir"] && values["home-dir"])
    throw new Error("Choose --base-dir or --home-dir, not both.");
  const explicitHome = values["base-dir"] ?? values["home-dir"] ?? process.env.T3CODE_HOME;
  const paths = await Effect.runPromise(
    Effect.gen(function* () {
      const baseDir = yield* resolveBaseDir(explicitHome);
      return yield* ServerConfig.deriveServerPaths(
        baseDir,
        process.env.VITE_DEV_SERVER_URL ? new URL(process.env.VITE_DEV_SERVER_URL) : undefined,
        { baseDirIsExplicit: explicitHome !== undefined && explicitHome.trim().length > 0 },
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );
  const databasePath = await NodeFSP.realpath(values.database ?? paths.dbPath);
  if (values.apply) {
    if (!values.offline)
      throw new Error("--apply requires --offline: stop and hold the owning server first.");
    const runtime = await Effect.runPromise(
      readPersistedServerRuntimeState(paths.serverRuntimeStatePath).pipe(
        Effect.provide(NodeServices.layer),
      ),
    );
    const rawPort =
      values.port ??
      process.env.T3CODE_PORT ??
      (Option.isSome(runtime) ? String(runtime.value.port) : undefined);
    // A stopped web server may have selected a different free port. Never guess 3773.
    if (rawPort === undefined)
      throw new Error(
        "--apply requires --port <configured-port> when no server runtime port is recorded.",
      );
    const port = Number(rawPort);
    if (!Number.isInteger(port) || port < 1 || port > 65535)
      throw new Error("Invalid configured server port.");
    await verifyRepairOffline(databasePath, port);
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
}
