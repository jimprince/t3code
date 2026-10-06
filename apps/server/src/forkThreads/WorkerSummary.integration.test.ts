import { ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { readWorkerSummaries } from "./WorkerSummaryService.ts";

const encodeMessage = Schema.encodeSync(
  Schema.fromJsonString(Schema.Struct({ text: Schema.String })),
);

describe("bounded V2 worker summaries", () => {
  it.effect("selects newest assistant, counts only selected children and bounds output", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TABLE orchestration_v2_projection_threads(thread_id TEXT)`;
      yield* sql`CREATE TABLE orchestration_v2_projection_messages(thread_id TEXT,role TEXT,updated_at TEXT,message_id TEXT,payload_json TEXT)`;
      yield* sql`CREATE TABLE orchestration_v2_projection_turn_items(thread_id TEXT,type TEXT,ordinal INTEGER)`;
      yield* sql`CREATE TABLE orchestration_v2_projection_provider_turns(thread_id TEXT,ordinal INTEGER,payload_json TEXT)`;
      yield* sql`INSERT INTO orchestration_v2_projection_threads VALUES ('child'),('root')`;
      yield* sql`INSERT INTO orchestration_v2_projection_messages VALUES ('child','assistant','1','a',${encodeMessage({ text: "old" })}),('child','assistant','2','b',${encodeMessage({ text: "\n" + "x".repeat(400) + "\nsecond" })}),('child','user','3','c',${encodeMessage({ text: "question" })}),('root','assistant','4','d',${encodeMessage({ text: "do not summarize" })})`;
      yield* sql`INSERT INTO orchestration_v2_projection_turn_items VALUES ('child','command_execution',1)`;
      yield* sql`INSERT INTO orchestration_v2_projection_provider_turns VALUES ('child',1,'{"tokenUsage":{"usedTokens":12}}')`;
      const result = yield* readWorkerSummaries(sql, [ThreadId.make("child")]);
      expect(result.size).toBe(1);
      expect(result.get("child")).toMatchObject({
        output: "x".repeat(320),
        messageCount: 3,
        toolCount: 1,
        usedTokens: 12,
      });
      expect((yield* readWorkerSummaries(sql, [])).size).toBe(0);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );
});
