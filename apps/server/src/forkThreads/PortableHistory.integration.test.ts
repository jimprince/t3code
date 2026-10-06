import { assert, it } from "@effect/vitest";
import { CommandId, MessageId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import {
  v2Projection,
  v2Now,
} from "../../../../packages/client-runtime/src/state/orchestrationV2TestFixtures.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as EventStore from "../orchestration-v2/EventStore.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as Receipts from "../orchestration-v2/CommandReceiptStore.ts";
import * as PortableHistory from "./PortableHistory.ts";

const stores = Layer.mergeAll(EventStore.layer, ProjectionStore.layer, Receipts.layer).pipe(
  Layer.provideMerge(SqlitePersistenceMemory),
);
const dependencies = Layer.merge(stores, EventSink.layer.pipe(Layer.provide(stores)));
const live = PortableHistory.layer.pipe(Layer.provideMerge(dependencies));
it.effect(
  "imports history durably once without native restore identities, rejects collisions and survives service restart",
  () =>
    Effect.gen(function* () {
      const history = yield* PortableHistory.PortableHistory;
      const store = yield* ProjectionStore.ProjectionStoreV2;
      const sql = yield* SqlClient.SqlClient;
      const id = ThreadId.make("portable-fork");
      const input = {
        commandId: CommandId.make("portable-import"),
        thread: {
          ...v2Projection.thread,
          id,
          forkedFrom: null,
          lineage: {
            parentThreadId: v2Projection.thread.id,
            relationshipToParent: "fork" as const,
            rootThreadId: v2Projection.thread.id,
          },
        },
        messages: [
          {
            id: MessageId.make("old-message"),
            threadId: v2Projection.thread.id,
            runId: null,
            nodeId: null,
            role: "user" as const,
            text: "Keep this context",
            attachments: [],
            streaming: false,
            createdBy: "user" as const,
            creationSource: "server" as const,
            createdAt: v2Now,
            updatedAt: v2Now,
          },
        ],
      };
      yield* history.import(input);
      const before = yield* sql`SELECT * FROM orchestration_v2_events ORDER BY sequence`;
      yield* history.import(input);
      yield* history.import(input).pipe(Effect.provide(PortableHistory.layer));
      assert.deepStrictEqual(
        yield* sql`SELECT * FROM orchestration_v2_events ORDER BY sequence`,
        before,
      );
      const projection = yield* store.getThreadProjection(id);
      assert.equal(projection.messages[0]?.text, "Keep this context");
      assert.equal(projection.messages[0]?.runId, null);
      assert.equal(projection.turnItems[0]?.runId, null);
      assert.equal(projection.thread.forkedFrom, null);
      assert.equal(projection.thread.lineage.parentThreadId, v2Projection.thread.id);
      assert.equal(projection.runs.length, 0);
      assert.equal(projection.checkpoints.length, 0);
      assert.equal(projection.thread.historyOrigin, "v1_import");
      const collision = yield* Effect.result(
        history.import({ ...input, commandId: CommandId.make("different-operation") }),
      );
      assert.isTrue(collision._tag === "Failure");
      assert.deepStrictEqual((yield* store.getThreadProjection(id)).messages, projection.messages);
    }).pipe(Effect.provide(live)),
);
