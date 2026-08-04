import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("037_UniqueProjectCreation", (it) => {
  it.effect("allows only one creation event for a project stream", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations();
      const insert = (eventId: string, streamVersion: number) => sql`
        INSERT INTO orchestration_events (
          event_id, aggregate_kind, stream_id, stream_version, event_type,
          occurred_at, command_id, causation_event_id, correlation_id,
          actor_kind, payload_json, metadata_json
        ) VALUES (
          ${eventId}, 'project', 'same-project', ${streamVersion}, 'project.created',
          '2026-01-01T00:00:00.000Z', NULL, NULL, NULL,
          'server', '{}', '{}'
        )
      `;

      yield* insert("event-create-1", 0);
      const duplicate = yield* Effect.exit(insert("event-create-2", 1));
      assert.equal(Exit.isFailure(duplicate), true);
    }),
  );
});
