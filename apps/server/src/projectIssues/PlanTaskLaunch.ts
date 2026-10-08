// @effect-diagnostics-next-line nodeBuiltinImport:off -- Preserve synchronous persisted task-worker SHA256 identities.
import * as NodeCrypto from "node:crypto";
import { CommandId, MessageId, ProjectIssuesError, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import { makeNestingService } from "../forkThreads/NestingService.ts";
import { ThreadLaunchService } from "../orchestration-v2/ThreadLaunchService.ts";
import { ThreadManagementService } from "../orchestration-v2/ThreadManagementService.ts";
import type { PlanTask } from "./planPublication.logic.ts";

export interface PlanTaskLaunchInput {
  readonly parentThreadId: ThreadId;
  readonly identity: string;
  readonly task: PlanTask;
  readonly issue: string;
}
export type PlanTaskLauncher = (
  input: PlanTaskLaunchInput,
) => Effect.Effect<ThreadId, ProjectIssuesError>;

/** Stable native receipts make retries recover the same nested worker and first turn. */
export const make = Effect.gen(function* () {
  const threads = yield* ThreadManagementService;
  const launches = yield* ThreadLaunchService;
  const sql = yield* SqlClient.SqlClient;
  const nesting = yield* makeNestingService(sql, threads.getThreadShell, threads.dispatch).pipe(
    Effect.mapError((error) => new ProjectIssuesError({ message: String(error) })),
  );
  const start: PlanTaskLauncher = Effect.fn("PlanTaskLaunch.start")(function* (
    input: PlanTaskLaunchInput,
  ) {
    const parent = yield* threads
      .getThreadRecords(input.parentThreadId, [])
      .pipe(
        Effect.mapError(
          () => new ProjectIssuesError({ message: "Could not read the task's owner thread." }),
        ),
      );
    if (parent.thread.archivedAt !== null || parent.thread.deletedAt !== null)
      return yield* new ProjectIssuesError({
        message: "The task's owner thread is no longer active.",
      });
    const digest = NodeCrypto.createHash("sha256").update(input.identity).digest("hex");
    const id = ThreadId.make(
      `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-a${digest.slice(17, 20)}-${digest.slice(20, 32)}`,
    );
    const existing = yield* threads
      .getThreadShell(id)
      .pipe(
        Effect.mapError(
          () => new ProjectIssuesError({ message: "Could not inspect an existing task worker." }),
        ),
      );
    if (
      existing &&
      (existing.projectId !== parent.thread.projectId ||
        existing.archivedAt !== null ||
        existing.deletedAt !== null)
    )
      return yield* new ProjectIssuesError({
        message: "The existing task worker is archived or belongs to another project.",
      });
    if (existing?.latestRunId != null) return id;
    const base = {
      threadId: id,
      projectId: parent.thread.projectId,
      title: input.task.title,
      modelSelection: parent.thread.modelSelection,
      runtimeMode: parent.thread.runtimeMode,
      interactionMode: parent.thread.interactionMode,
      workspaceStrategy: parent.thread.worktreePath
        ? {
            type: "existing_worktree" as const,
            worktreePath: parent.thread.worktreePath,
            ...(parent.thread.branch === null ? {} : { branch: parent.thread.branch }),
          }
        : {
            type: "root" as const,
            ...(parent.thread.branch === null ? {} : { branch: parent.thread.branch }),
          },
      createdBy: "agent" as const,
      creationSource: "mcp" as const,
    };
    const mapError = (error: unknown) =>
      new ProjectIssuesError({
        message: `Could not launch task ${input.task.key}: ${String(error)}`,
      });
    // Claim an empty shell, record its owner, then gate the first message on its issue.
    if (!existing)
      yield* launches
        .launch({ ...base, commandId: CommandId.make(`plan-claim-${digest}`) })
        .pipe(Effect.mapError(mapError));
    yield* nesting
      .update({
        commandId: CommandId.make(`plan-nest-${digest}`),
        threadId: id,
        parentThreadId: input.parentThreadId,
      })
      .pipe(Effect.mapError(mapError));
    yield* launches
      .launch({
        ...base,
        commandId: CommandId.make(`plan-start-${digest}`),
        reuseExistingThread: true,
        issue: input.issue,
        initialMessage: {
          messageId: MessageId.make(`plan-message-${digest}`),
          senderThreadId: input.parentThreadId,
          text: `Task: ${input.task.title}\nIssue: ${input.issue}\nOwner: ${input.task.owner}\n\n${input.task.detail}`,
          attachments: [],
        },
      })
      .pipe(Effect.mapError(mapError));
    return id;
  });
  return start;
});
