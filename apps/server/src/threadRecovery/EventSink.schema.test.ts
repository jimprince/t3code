import { it } from "@effect/vitest";
import { expect } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Tracer from "effect/Tracer";
import {
  execute,
  seed,
  old,
  successor,
  event,
  message,
  messageId,
  write,
} from "./Recovery.testkit.ts";

it.live("checks thread-fence schema once while reading newly inserted fences on each write", () => {
  const schemaQueries: string[] = [];
  const tracer = Tracer.make({
    span(options) {
      const span = new Tracer.NativeSpan(options);
      const end = span.end.bind(span);
      span.end = (time, exit) => {
        end(time, exit);
        const query = span.attributes.get("db.query.text");
        if (
          typeof query === "string" &&
          query.includes("sqlite_master") &&
          query.includes("fork_recovery_thread_fences")
        )
          schemaQueries.push(query);
      };
      return span;
    },
  });
  return execute(
    Effect.gen(function* () {
      yield* seed();
      const sql = yield* SqlClient.SqlClient;
      yield* write([
        event({ type: "message.updated", threadId: old, payload: message(messageId) }),
      ]);
      yield* sql`INSERT INTO fork_recovery_thread_fences(thread_id,successor_thread_id,operation_id) VALUES(${old},${successor},'test-operation')`;
      const blocked = yield* write([
        event({ type: "message.updated", threadId: old, payload: message(messageId) }),
      ]).pipe(Effect.flip);
      expect(blocked._tag).toBe("EventSinkWriteError");
      yield* sql`DELETE FROM fork_recovery_thread_fences WHERE thread_id=${old}`;
      const written = yield* write([
        event({ type: "message.updated", threadId: old, payload: message(messageId) }),
      ]);
      expect(written).toHaveLength(1);
      expect(schemaQueries).toHaveLength(1);
    }),
  ).pipe(Effect.withTracer(tracer));
});
