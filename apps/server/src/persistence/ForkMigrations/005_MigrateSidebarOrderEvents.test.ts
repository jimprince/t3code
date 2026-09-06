import { ThreadId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { runMigrations } from "../Migrations.ts";
import { runForkMigrations } from "../ForkMigrations.ts";
import { OrchestrationEventStoreLive } from "../Layers/OrchestrationEventStore.ts";
import { OrchestrationEventStore } from "../Services/OrchestrationEventStore.ts";

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeLegacy = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      threadId: Schema.String,
      orderKey: Schema.NullOr(Schema.String),
      updatedAt: Schema.String,
    }),
  ),
);

const layer = it.layer(
  OrchestrationEventStoreLive.pipe(Layer.provideMerge(NodeSqliteClient.layerMemory())),
);
layer("legacy sidebar ordering migration", (it) => {
  it.effect("migrates the released ledger losslessly, once, and replays both ranges", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const store = yield* OrchestrationEventStore;
      yield* runMigrations();
      yield* runForkMigrations({ toMigrationInclusive: 3 });
      // ID 4 shipped with the retired ordering feature. Never reuse its ID.
      yield* sql`INSERT INTO effect_sql_fork_migrations (migration_id, name)
        VALUES (4, 'ProjectionThreadsSidebarOrderKey')`;
      const now = "2026-09-05T12:00:00.000Z";
      for (const [index, orderKey] of ["a0", null].entries()) {
        yield* sql`INSERT INTO orchestration_events (
          event_id, aggregate_kind, stream_id, stream_version, event_type,
          occurred_at, command_id, causation_event_id, correlation_id, actor_kind,
          payload_json, metadata_json
        ) VALUES (
          ${`legacy-${index}`}, 'thread', 'thread-order', ${index + 1},
          'thread.sidebar-reordered', ${now}, ${`command-${index}`}, 'cause', 'correlation',
          'client', ${encodeJson({ threadId: "thread-order", orderKey, updatedAt: now })},
          '{"origin":{"surface":"cli"}}'
        )`;
      }
      yield* sql`INSERT INTO orchestration_events (
        event_id, aggregate_kind, stream_id, stream_version, event_type,
        occurred_at, actor_kind, payload_json, metadata_json
      ) VALUES ('unrelated', 'thread', 'thread-order', 3, 'thread.meta-updated',
        ${now}, 'client', ${encodeJson({ threadId: "thread-order", title: "Keep me", updatedAt: now })}, '{}')`;
      const before = yield* sql`SELECT * FROM orchestration_events ORDER BY sequence`;
      assert.deepStrictEqual(yield* runForkMigrations(), [[5, "MigrateSidebarOrderEvents"]]);
      const after = yield* sql`SELECT * FROM orchestration_events ORDER BY sequence`;
      assert.equal(after.length, before.length);
      for (let index = 0; index < 2; index++) {
        const original = before[index]!;
        const { orderKey, ...rest } = decodeLegacy(String(original.payload_json));
        assert.deepStrictEqual(after[index], {
          ...original,
          event_type: "thread.meta-updated",
          payload_json: encodeJson({ ...rest, activeOrderKey: orderKey }),
        });
      }
      assert.deepStrictEqual(after[2], before[2]);
      assert.deepStrictEqual(yield* runForkMigrations(), []);
      assert.deepStrictEqual(
        yield* sql`SELECT * FROM orchestration_events ORDER BY sequence`,
        after,
      );
      const all = Array.from(yield* Stream.runCollect(store.readFromSequence(0, 10)));
      const aggregate = Array.from(
        yield* Stream.runCollect(
          store.readAggregateRange({
            aggregateKind: "thread",
            aggregateId: "thread-order",
            fromSequenceExclusive: 0,
            toSequenceInclusive: 3,
          }),
        ),
      );
      assert.deepStrictEqual(aggregate, all);
      assert.equal(all.length, 3);
      assert.deepStrictEqual(
        all.slice(0, 2).map((event) => event.payload),
        [
          { threadId: ThreadId.make("thread-order"), updatedAt: now, activeOrderKey: "a0" },
          { threadId: ThreadId.make("thread-order"), updatedAt: now, activeOrderKey: null },
        ],
      );
    }),
  );
});
