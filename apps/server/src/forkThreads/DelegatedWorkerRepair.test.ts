// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeURL from "node:url";
import * as NodeUtil from "node:util";
import * as NodeCrypto from "node:crypto";
import * as NodeSqlite from "node:sqlite";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  NodeId,
  ProjectId,
  ProviderInstanceId,
  ProviderDriverKind,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";
import { layerMemory as SqlitePersistenceMemory } from "../persistence/Sqlite.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as EventStore from "../orchestration-v2/EventStore.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import { layerWithRegistry as makeOrchestratorV2ReplayLayerWithRegistry } from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import { makeNestingService } from "./NestingService.ts";
import { listMetadata } from "./MetadataStore.ts";
import * as DelegatedWorkerRepair from "./DelegatedWorkerRepair.ts";
import * as HostProcess from "@t3tools/shared/HostProcess";

const decodeScriptReceipt = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      mode: Schema.String,
      changes: Schema.Array(Schema.Struct({ threadId: Schema.String })),
      wouldApply: Schema.optional(Schema.Array(Schema.String)),
      applied: Schema.optional(Schema.Array(Schema.String)),
    }),
  ),
);

const database = SqlitePersistenceMemory;
const runtime = makeOrchestratorV2ReplayLayerWithRegistry(
  { name: "delegated-worker-repair" },
  ProviderAdapterRegistry.layerFromAdapters([]),
  { databaseLayer: database, runEffectWorker: false },
);
const layer = Layer.mergeAll(
  runtime,
  ThreadManagement.layer.pipe(Layer.provide(runtime)),
  EventStore.layer,
  ProjectionStore.layer,
).pipe(Layer.provideMerge(database));
it.effect(
  "dry-run audits inherited fields, preserves explicit decisions, applies idempotently and keeps event replay intact",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const management = yield* ThreadManagement.ThreadManagementService;
      const sink = yield* EventSink.EventSinkV2;
      const events = yield* EventStore.EventStoreV2;
      const store = yield* ProjectionStore.ProjectionStoreV2;
      const parentId = ThreadId.make("repair-owner");
      yield* management.dispatch({
        type: "thread.create",
        commandId: CommandId.make("repair-create-parent"),
        threadId: parentId,
        projectId: ProjectId.make("repair-project"),
        title: "Owner",
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "model" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdBy: "user",
        creationSource: "web",
      });
      yield* management.dispatch({
        type: "thread.pin",
        commandId: CommandId.make("repair-pin-parent"),
        threadId: parentId,
        orderKey: "an",
      });
      yield* management.dispatch({
        type: "thread.auto-settle.set",
        commandId: CommandId.make("repair-opt-out-parent"),
        threadId: parentId,
        enabled: false,
      });
      const parent = yield* store.getThread(parentId);
      const now = yield* DateTime.now;
      for (const name of ["affected", "manual-pin", "explicit-unnest", "clean"]) {
        const threadId = ThreadId.make(`thread:delegated-task:${name}`);
        const child = {
          ...parent,
          id: threadId,
          title: name,
          createdAt: now,
          updatedAt: now,
          lineage: {
            parentThreadId: parentId,
            rootThreadId: parentId,
            relationshipToParent: "subagent" as const,
          },
          ...(name === "affected" || name === "manual-pin"
            ? {}
            : { pinnedAt: null, pinOrderKey: null, autoSettleDisabledAt: null }),
        };
        yield* sink.write({
          commandId: CommandId.make(`historical-${name}`),
          events: [
            {
              id: EventId.make(`historical-create-${name}`),
              type: "thread.created",
              threadId,
              occurredAt: now,
              payload: child,
            },
            {
              id: EventId.make(`historical-task-${name}`),
              type: "subagent.updated",
              threadId: parentId,
              occurredAt: now,
              payload: {
                id: NodeId.make(`task-${name}`),
                threadId: parentId,
                runId: RunId.make("parent-run"),
                parentNodeId: NodeId.make("parent-node"),
                origin: "app_owned",
                createdBy: "agent",
                driver: ProviderDriverKind.make("codex"),
                providerInstanceId: parent.providerInstanceId,
                providerThreadId: null,
                childThreadId: threadId,
                nativeTaskRef: null,
                prompt: name,
                title: name,
                model: "model",
                status: "completed",
                result: "done",
                startedAt: now,
                completedAt: now,
                updatedAt: now,
              },
            },
          ],
        });
        if (name === "affected")
          yield* sql`DELETE FROM fork_thread_metadata WHERE thread_id = ${threadId}`;
      }
      const unnestId = ThreadId.make("thread:delegated-task:explicit-unnest");
      const nesting = yield* makeNestingService(
        sql,
        management.getThreadShell,
        management.dispatch,
      );
      yield* nesting.update({
        commandId: CommandId.make("explicit-unnest"),
        threadId: unnestId,
        parentThreadId: null,
        settleOnComplete: null,
      });
      const pinnedId = ThreadId.make("thread:delegated-task:manual-pin");
      yield* management.dispatch({
        type: "thread.pin",
        commandId: CommandId.make("manual-pin"),
        threadId: pinnedId,
      });
      yield* management.dispatch({
        type: "thread.auto-settle.set",
        commandId: CommandId.make("manual-opt-out"),
        threadId: pinnedId,
        enabled: false,
      });
      const repair = yield* DelegatedWorkerRepair.DelegatedWorkerRepair;
      const sequence = yield* events.latestSequence();
      const dryRun = yield* repair.inspect();
      assert.deepStrictEqual(
        dryRun.changes.map((change) => change.threadId),
        ["thread:delegated-task:affected"],
      );
      assert.deepStrictEqual(
        dryRun.changes[0]!.fields.map(({ field }) => field),
        ["pinnedAt", "pinOrderKey", "autoSettleDisabledAt"],
      );
      assert.equal(yield* events.latestSequence(), sequence);
      assert.equal(
        (yield* listMetadata(sql)).some((row) => row.threadId === dryRun.changes[0]!.threadId),
        false,
      );
      const directory = yield* Effect.acquireRelease(
        Effect.promise(() => NodeFSP.mkdtemp("/tmp/t3-delegated-repair-")),
        (path) => Effect.promise(() => NodeFSP.rm(path, { recursive: true, force: true })),
      );
      yield* Effect.promise(() => NodeFSP.mkdir(`${directory}/userdata`));
      const snapshot = `${directory}/userdata/statev2.sqlite`;
      yield* sql.unsafe("VACUUM INTO ?", [snapshot]);
      const execFile = NodeUtil.promisify(NodeChildProcess.execFile);
      const script = NodeURL.fileURLToPath(new URL("../bin.ts", import.meta.url));
      const executablePath = yield* HostProcess.ExecutablePath;
      const runScript = (flags: string[]) =>
        Effect.tryPromise(() =>
          execFile(executablePath, [
            script,
            "repair-delegated-workers",
            "--base-dir",
            directory,
            "--port",
            "65534",
            ...flags,
          ]),
        );
      const hashSource = () =>
        Effect.promise(async () =>
          NodeCrypto.createHash("sha256")
            .update(await NodeFSP.readFile(snapshot))
            .digest("hex"),
        );
      const sourceHash = yield* hashSource();
      // A read-only snapshot remains safe while another process owns the source database.
      const sourceOwner = yield* Effect.acquireRelease(
        Effect.sync(() => new NodeSqlite.DatabaseSync(snapshot)),
        (owner) =>
          Effect.sync(() => {
            if (owner.isOpen) owner.close();
          }),
      );
      const scriptDryRun = decodeScriptReceipt((yield* runScript([])).stdout);
      assert.equal(yield* hashSource(), sourceHash);
      assert.equal(scriptDryRun.mode, "dry-run");
      assert.deepStrictEqual(
        scriptDryRun.changes.map((row) => row.threadId),
        ["thread:delegated-task:affected"],
      );
      assert.deepStrictEqual(scriptDryRun.wouldApply, ["thread:delegated-task:affected"]);
      assert.equal((yield* Effect.exit(runScript(["--apply"])))._tag, "Failure");
      assert.equal((yield* Effect.exit(runScript(["--apply", "--offline"])))._tag, "Failure");
      sourceOwner.close();
      // Unprivileged hosts must refuse incomplete /proc inspection. Privileged
      // CI can prove the packaged command's successful apply on this same fixture.
      const scriptApply = yield* Effect.result(runScript(["--apply", "--offline"]));
      if (scriptApply._tag === "Success") {
        assert.deepStrictEqual(decodeScriptReceipt(scriptApply.success.stdout).applied, [
          "thread:delegated-task:affected",
        ]);
        assert.deepStrictEqual(
          decodeScriptReceipt((yield* runScript(["--apply", "--offline"])).stdout).applied,
          [],
        );
      } else {
        assert.match(
          String(scriptApply.failure.cause),
          /Cannot inspect process .*sufficient privileges/,
        );
      }
      const applied = yield* repair.apply();
      assert.deepStrictEqual(applied.applied, ["thread:delegated-task:affected"]);
      assert.deepStrictEqual(applied.remaining.changes, []);
      assert.deepStrictEqual((yield* repair.apply()).applied, []);
      const repaired = yield* store.getThread(ThreadId.make("thread:delegated-task:affected"));
      assert.equal(repaired.pinnedAt, null);
      assert.equal(repaired.autoSettleDisabledAt, null);
      assert.equal(
        (yield* listMetadata(sql)).find((row) => row.threadId === repaired.id)?.parentThreadId,
        parentId,
      );
      assert.equal(
        (yield* listMetadata(sql)).find((row) => row.threadId === unnestId)?.parentThreadId,
        null,
      );
      assert.isNotNull((yield* store.getThread(pinnedId)).pinnedAt);
      assert.isNotNull((yield* store.getThread(pinnedId)).autoSettleDisabledAt);
      yield* Effect.gen(function* () {
        const replay = yield* ProjectionStore.ProjectionStoreV2;
        yield* Stream.runForEach(events.read(), ({ event }) => replay.apply(event));
        const restored = yield* replay.getThread(repaired.id);
        assert.equal(restored.pinnedAt, null);
        assert.equal(restored.autoSettleDisabledAt, null);
        assert.equal(restored.lineage.parentThreadId, parentId);
      }).pipe(Effect.provide(ProjectionStore.layerMemory));
    }).pipe(Effect.provide(DelegatedWorkerRepair.layer.pipe(Layer.provideMerge(layer)))),
);
