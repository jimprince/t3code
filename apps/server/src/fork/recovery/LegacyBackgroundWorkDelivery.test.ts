import { expect, it } from "@effect/vitest";
import { DEFAULT_SERVER_SETTINGS, type OrchestrationV2ThreadProjection } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ConfigProvider from "effect/ConfigProvider";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as ThreadManagement from "../../orchestration-v2/ThreadManagementService.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as Import from "./LegacyBackgroundWorkImport.ts";

it.live("preserves old rows and skips delivered, stopped, or settled notices", () =>
  Effect.gen(function* () {
    const time = DateTime.makeUnsafe("2026-10-05T00:00:00Z");
    let delivered = false;
    let deliveries = 0;
    let command: string | undefined;
    const projection = (id: string) =>
      ({
        thread: {
          id,
          projectId: "project",
          updatedAt: time,
          archivedAt: null,
          deletedAt: null,
          snoozedUntil: null,
          settledOverride: id === "settled" ? "settled" : null,
        },
        runs: [],
        runtimeRequests: [],
        messages: delivered ? [{ id: "message:legacy-background-work:idle:old" }] : [],
      }) as unknown as OrchestrationV2ThreadProjection;
    const persistence = NodeSqliteClient.layer({ filename: ":memory:" });
    const importer = Import.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          persistence,
          Layer.mock(ThreadManagement.ThreadManagementService)({
            ensureLegacyTranscript: () => Effect.void,
            getThreadProjection: (id) => Effect.succeed(projection(id)),
            dispatch: (input) =>
              Effect.sync(() => {
                deliveries++;
                command = input.commandId;
                delivered = true;
                return {} as never;
              }),
          }),
          Layer.mock(ServerSettings.ServerSettingsService)({
            getSettings: Effect.succeed({
              ...DEFAULT_SERVER_SETTINGS,
              continueThreadsAfterServerUpdate: true,
            }),
          }),
        ),
      ),
    );
    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TABLE fork_thread_background_work (thread_id TEXT, tasks_json TEXT, updated_at TEXT)`;
      yield* sql`CREATE TABLE projection_thread_sessions (thread_id TEXT, status TEXT)`;
      yield* sql`CREATE TABLE projection_threads (thread_id TEXT, latest_turn_id TEXT)`;
      yield* sql`CREATE TABLE projection_turns (thread_id TEXT, turn_id TEXT, state TEXT)`;
      for (const id of ["idle", "settled", "stopped"]) {
        yield* sql`INSERT INTO fork_thread_background_work VALUES (${id}, ${'[{"taskId":"agent","kind":"agent"},{"taskId":"monitor","kind":"monitor"}]'}, 'old')`;
      }
      yield* sql`INSERT INTO projection_thread_sessions VALUES ('stopped', 'stopped')`;
      const recovery = yield* Import.LegacyBackgroundWorkImport;
      yield* recovery.recover.pipe(
        Effect.provideService(
          ConfigProvider.ConfigProvider,
          ConfigProvider.fromUnknown({ T3CODE_DISABLE_STARTUP_RESUME: true }),
        ),
      );
      expect(deliveries).toBe(0);
      yield* recovery.recover;
      yield* recovery.recover;
      expect(deliveries).toBe(1);
      expect(command).toBe("command:legacy-background-work:idle:old");
      expect(yield* sql`SELECT * FROM fork_thread_background_work`).toHaveLength(3);
    }).pipe(
      Effect.provide(Layer.mergeAll(importer, persistence)),
      Effect.provideService(
        ConfigProvider.ConfigProvider,
        ConfigProvider.fromUnknown({ T3CODE_DISABLE_STARTUP_RESUME: false }),
      ),
    );
  }),
);
