import { CommandId, MessageId, ThreadId } from "@t3tools/contracts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as ThreadManagement from "../../orchestration-v2/ThreadManagementService.ts";
import * as ServerSettings from "../../serverSettings.ts";
import { legacyNoticeCanStart } from "./LegacyBackgroundWorkPolicy.ts";
import { automaticStartupResumeAllowed } from "./StartupResumePolicy.ts";

const Task = Schema.Struct({
  taskId: Schema.String,
  kind: Schema.Literals(["agent", "monitor"]),
  description: Schema.optional(Schema.String),
});
const decodeTasks = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Array(Task)));
export function stoppedBackgroundWorkNotice(tasks: ReadonlyArray<typeof Task.Type>): string {
  return [
    "T3 Code restarted, which stopped this thread's background work:",
    ...tasks
      .slice(0, 20)
      .map(
        (task) =>
          `- ${task.kind === "agent" ? "Background agent" : "Monitor"}: ${task.description?.slice(0, 200) ?? "(no description)"}`,
      ),
    ...(tasks.length > 20 ? [`- and ${tasks.length - 20} more`] : []),
    "Relaunch each one now, the same way you started it, unless its job is done or no longer needed. Don't ask first. Anything it would have reported during the restart was missed, so check the current state as you relaunch.",
  ].join("\n");
}
export class LegacyBackgroundWorkImport extends Context.Service<
  LegacyBackgroundWorkImport,
  {
    readonly recover: Effect.Effect<void>;
  }
>()("t3/fork/recovery/LegacyBackgroundWorkImport") {}
const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const settingsService = yield* ServerSettings.ServerSettingsService;
  const recover = Effect.gen(function* () {
    if (!(yield* automaticStartupResumeAllowed)) return;
    const settings = yield* settingsService.getSettings;
    const rows = yield* sql<{ thread_id: string; tasks_json: string; updated_at: string }>`
      SELECT work.thread_id, work.tasks_json, work.updated_at FROM fork_thread_background_work work
      LEFT JOIN projection_thread_sessions session ON session.thread_id = work.thread_id
      LEFT JOIN projection_threads thread ON thread.thread_id = work.thread_id
      LEFT JOIN projection_turns turn ON turn.thread_id = thread.thread_id AND turn.turn_id = thread.latest_turn_id
      WHERE COALESCE(session.status, '') NOT IN ('stopped', 'interrupted', 'error')
        AND COALESCE(turn.state, '') NOT IN ('interrupted', 'error')
    `;
    for (const row of rows) {
      yield* Effect.gen(function* () {
        const tasks = decodeTasks(row.tasks_json);
        if (Option.isNone(tasks) || tasks.value.length === 0) return;
        const threadId = ThreadId.make(row.thread_id);
        const messageId = MessageId.make(
          `message:legacy-background-work:${row.thread_id}:${row.updated_at}`,
        );
        yield* threads.ensureLegacyTranscript(threadId);
        const projection = yield* threads.getThreadProjection(threadId);
        if (
          projection.messages.some((message) => message.id === messageId) ||
          !legacyNoticeCanStart(projection, projection.thread.updatedAt) ||
          !resolveProjectSettings(settings, projection.thread.projectId).settings
            .continueThreadsAfterServerUpdate
        )
          return;
        // The source row remains historical. Native messages and command receipts
        // are the durable delivery marker, including a crash after acceptance.
        yield* threads.dispatch({
          type: "message.dispatch",
          threadId,
          messageId,
          commandId: CommandId.make(
            `command:legacy-background-work:${row.thread_id}:${row.updated_at}`,
          ),
          text: stoppedBackgroundWorkNotice(tasks.value),
          attachments: [],
          dispatchMode: { type: "start_immediately" },
          createdBy: "agent",
          creationSource: "server",
          recoveryExpectedUpdatedAt: projection.thread.updatedAt,
        });
      }).pipe(
        Effect.catch((cause) =>
          Effect.logWarning("legacy background-work notice remains pending", {
            threadId: row.thread_id,
            cause,
          }),
        ),
      );
    }
  }).pipe(
    Effect.catch((cause) =>
      Effect.logWarning("legacy background-work notice remains pending", { cause }),
    ),
  );
  return LegacyBackgroundWorkImport.of({ recover });
});
export const layer = Layer.effect(LegacyBackgroundWorkImport, make);
/** Optional in narrow startup tests; production composition always provides the bridge. */
export const recoverLegacyBackgroundWork = Effect.gen(function* () {
  const service = yield* Effect.serviceOption(LegacyBackgroundWorkImport);
  if (Option.isSome(service)) yield* service.value.recover;
});
