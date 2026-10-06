import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/** Convert the retired fork ordering event to upstream's metadata event once. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    UPDATE orchestration_events
    SET event_type = 'thread.meta-updated',
        payload_json = json_remove(
          json_set(payload_json, '$.activeOrderKey', json_extract(payload_json, '$.orderKey')),
          '$.orderKey'
        )
    WHERE event_type = 'thread.sidebar-reordered'
  `;
});
