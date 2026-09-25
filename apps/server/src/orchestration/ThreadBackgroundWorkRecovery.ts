/**
 * ThreadBackgroundWorkRecovery - resumes background work a server restart
 * stopped (fork-resume-background-work).
 *
 * A restart kills every provider process and with it each thread's background
 * sub-agents, workflows and monitors. The in-memory liveness registry forgets
 * them, while the agent's transcript still says they are running. Runtime
 * ingestion mirrors each thread's live background tasks into
 * `fork_thread_background_work` as they change. The next startup takes those
 * rows once and, when "Continue threads after restarts" is on, tells the agent
 * what stopped so it can check and relaunch what it still needs.
 *
 * Shutdown stops runtime ingestion before it stops provider sessions, so a
 * graceful restart keeps the rows. A session that exits while the server runs
 * clears them, because its background work is gone for good.
 *
 * @module ThreadBackgroundWorkRecovery
 */
import { type ProjectId, type ProviderInteractionMode, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as ProviderService from "../provider/Services/ProviderService.ts";
import * as ProviderSessionDirectory from "../provider/Services/ProviderSessionDirectory.ts";
import { forkParked } from "../serverActivation.ts";
import { ThreadBackgroundLivenessService } from "./ThreadBackgroundLiveness.ts";

const StoppedBackgroundTask = Schema.Struct({
  taskId: Schema.String,
  kind: Schema.Literals(["agent", "monitor"]),
  description: Schema.optional(Schema.String),
});
export type StoppedBackgroundTask = typeof StoppedBackgroundTask.Type;

const StoppedBackgroundTasksJson = Schema.fromJsonString(Schema.Array(StoppedBackgroundTask));
const encodeStoppedBackgroundTasks = Schema.encodeSync(StoppedBackgroundTasksJson);
const decodeStoppedBackgroundTasks = Schema.decodeUnknownOption(StoppedBackgroundTasksJson);

export type StoppedBackgroundWork = ReadonlyMap<ThreadId, ReadonlyArray<StoppedBackgroundTask>>;

export class ThreadBackgroundWorkRecovery extends Context.Service<
  ThreadBackgroundWorkRecovery,
  {
    /**
     * Mirror the thread's live background tasks after a liveness transition.
     * Writes only when the set or a description changed; never fails.
     */
    readonly sync: (
      threadId: ThreadId,
      describe: (taskId: string) => Effect.Effect<string | undefined>,
    ) => Effect.Effect<void>;

    /** Startup only: every recorded thread's tasks, deleted as they are read. */
    readonly takeAll: Effect.Effect<StoppedBackgroundWork>;
  }
>()("t3/orchestration/ThreadBackgroundWorkRecovery") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const liveness = yield* ThreadBackgroundLivenessService;
  const lock = yield* Semaphore.make(1);
  // Last tasks_json written per thread; absent means no row.
  const written = new Map<ThreadId, string>();

  const sync: ThreadBackgroundWorkRecovery["Service"]["sync"] = (threadId, describe) =>
    Effect.gen(function* () {
      const tasks = yield* Effect.forEach(liveness.getThreadBackgroundTasks(threadId), (task) =>
        describe(task.taskId).pipe(
          Effect.map((description): StoppedBackgroundTask =>
            description ? { ...task, description } : task,
          ),
        ),
      );
      const tasksJson = encodeStoppedBackgroundTasks(tasks);
      if ((written.get(threadId) ?? "[]") === tasksJson) {
        return;
      }
      if (tasks.length === 0) {
        yield* sql`DELETE FROM fork_thread_background_work WHERE thread_id = ${threadId}`;
        written.delete(threadId);
        return;
      }
      const updatedAt = DateTime.formatIso(yield* DateTime.now);
      yield* sql`
        INSERT INTO fork_thread_background_work (thread_id, tasks_json, updated_at)
        VALUES (${threadId}, ${tasksJson}, ${updatedAt})
        ON CONFLICT (thread_id) DO UPDATE SET
          tasks_json = excluded.tasks_json,
          updated_at = excluded.updated_at
      `;
      written.set(threadId, tasksJson);
    }).pipe(
      lock.withPermits(1),
      Effect.catch((cause) =>
        Effect.logWarning("failed to record thread background work", { threadId, cause }),
      ),
    );

  const takeAll: ThreadBackgroundWorkRecovery["Service"]["takeAll"] = Effect.gen(function* () {
    const rows = yield* sql<{ readonly threadId: string; readonly tasksJson: string }>`
      SELECT thread_id AS "threadId", tasks_json AS "tasksJson"
      FROM fork_thread_background_work
    `;
    yield* sql`DELETE FROM fork_thread_background_work`;
    written.clear();
    const stopped = new Map<ThreadId, ReadonlyArray<StoppedBackgroundTask>>();
    for (const row of rows) {
      const tasks = decodeStoppedBackgroundTasks(row.tasksJson);
      if (Option.isSome(tasks) && tasks.value.length > 0) {
        stopped.set(ThreadId.make(row.threadId), tasks.value);
      }
    }
    return stopped as StoppedBackgroundWork;
  }).pipe(
    lock.withPermits(1),
    Effect.catch((cause) =>
      Effect.logWarning("failed to read stopped thread background work", { cause }).pipe(
        Effect.as(new Map() as StoppedBackgroundWork),
      ),
    ),
  );

  return { sync, takeAll } satisfies ThreadBackgroundWorkRecovery["Service"];
});

export const layer = Layer.effect(ThreadBackgroundWorkRecovery, make);

/** Startup: take the recorded work once, or none where the service is absent (tests). */
export const takeStoppedBackgroundWork: Effect.Effect<StoppedBackgroundWork> = Effect.gen(
  function* () {
    const recovery = yield* Effect.serviceOption(ThreadBackgroundWorkRecovery);
    return Option.isSome(recovery)
      ? yield* recovery.value.takeAll
      : (new Map() as StoppedBackgroundWork);
  },
);

// Keeps the notice well inside the provider turn input limit.
const MAX_LISTED_TASKS = 20;

/** What the agent is told about the background work a restart stopped. */
export function stoppedBackgroundWorkNotice(tasks: ReadonlyArray<StoppedBackgroundTask>): string {
  const unlisted = tasks.length - MAX_LISTED_TASKS;
  return [
    "T3 Code restarted, which stopped this thread's background work:",
    ...tasks
      .slice(0, MAX_LISTED_TASKS)
      .map(
        (task) =>
          `- ${task.kind === "agent" ? "Background agent" : "Monitor"}: ${task.description?.slice(0, 200) ?? "(no description)"}`,
      ),
    ...(unlisted > 0 ? [`- and ${unlisted} more`] : []),
    "Anything it would have reported during the restart was missed. Check the current state, then relaunch the monitors and agents that are still needed. Skip any that no longer matter.",
  ].join("\n");
}

/** The mid-turn continuation prompt, extended with the notice when work stopped. */
export function continuationPromptWithStoppedWork(
  prompt: string,
  tasks: ReadonlyArray<StoppedBackgroundTask> | undefined,
): string {
  return tasks === undefined || tasks.length === 0
    ? prompt
    : `${prompt}\n\n${stoppedBackgroundWorkNotice(tasks)}`;
}

/**
 * Startup: send the notice to idle threads whose background work stopped.
 * Orphaned (mid-turn) threads are left to the upstream continuation, whose
 * prompt carries the same notice, or to its error settlement.
 */
export const resumeStoppedBackgroundWork = (input: {
  readonly stoppedWork: StoppedBackgroundWork;
  readonly orphanedThreadIds: ReadonlySet<ThreadId>;
  readonly liveThreadIds: ReadonlySet<ThreadId>;
  readonly threads: ReadonlyArray<{
    readonly id: ThreadId;
    readonly projectId: ProjectId;
    readonly archivedAt: string | null;
    readonly deletedAt: string | null;
    readonly interactionMode: ProviderInteractionMode;
  }>;
  readonly continueAfterRestartFor: (projectId: ProjectId) => boolean;
}) =>
  Effect.gen(function* () {
    if (input.stoppedWork.size === 0) {
      return;
    }
    const directory = yield* ProviderSessionDirectory.ProviderSessionDirectory;
    const providerService = yield* ProviderService.ProviderService;
    for (const thread of input.threads) {
      const tasks = input.stoppedWork.get(thread.id);
      if (
        tasks === undefined ||
        input.orphanedThreadIds.has(thread.id) ||
        input.liveThreadIds.has(thread.id) ||
        thread.archivedAt !== null ||
        thread.deletedAt !== null ||
        !input.continueAfterRestartFor(thread.projectId)
      ) {
        continue;
      }
      const binding = yield* directory
        .getBinding(thread.id)
        .pipe(Effect.orElseSucceed(() => Option.none()));
      // Without a resume cursor a new session would start without the
      // transcript that says what the work was.
      if (Option.isNone(binding) || binding.value.resumeCursor == null) {
        continue;
      }
      yield* forkParked(
        providerService
          .sendTurn({
            threadId: thread.id,
            input: stoppedBackgroundWorkNotice(tasks),
            interactionMode: thread.interactionMode,
          })
          .pipe(
            Effect.catch((cause) =>
              Effect.logWarning("failed to resume thread background work after restart", {
                threadId: thread.id,
                cause,
              }),
            ),
          ),
      );
    }
  });
