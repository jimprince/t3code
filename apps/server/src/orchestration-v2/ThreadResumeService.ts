import {
  CommandId,
  ThreadId,
  RunId,
  ThreadResumeError,
  type ThreadResumeFromPlanInput,
  type ThreadResumeResult,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import {
  threadResumeRefusal,
  threadTodoProgress,
  threadPlanResumeState,
} from "@t3tools/shared/threadPlan";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Crypto from "effect/Crypto";
import * as Hex from "effect/encoding/Hex";
import * as Schema from "effect/Schema";
import * as Layer from "effect/Layer";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";
import { readMetadata, writeMetadata } from "../forkThreads/MetadataStore.ts";
import { ThreadManagementService } from "./ThreadManagementService.ts";
import { ThreadLaunchService } from "./ThreadLaunchService.ts";
import { PlanFileService } from "./PlanFileService.ts";
import { buildFilePlanResumeSeed, buildThreadResumeSeed } from "./ThreadResumeSeed.ts";

export class ThreadResumeService extends Context.Service<
  ThreadResumeService,
  {
    readonly preview: (
      input: ThreadResumeFromPlanInput,
    ) => Effect.Effect<{ seed: string }, ThreadResumeError>;
    readonly resume: (
      input: ThreadResumeFromPlanInput,
    ) => Effect.Effect<ThreadResumeResult, ThreadResumeError>;
  }
>()("t3/orchestration-v2/ThreadResumeService") {}
const encodeResumeKey = Schema.encodeEffect(
  Schema.fromJsonString(Schema.Tuple([ThreadId, Schema.NullOr(RunId)])),
);
const unavailable = (_cause: unknown) =>
  new ThreadResumeError({
    reason: "unavailable",
    message: "Thread plan recovery could not be completed.",
  });
export const make = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const threads = yield* ThreadManagementService;
  const launches = yield* ThreadLaunchService;
  const sql = yield* SqlClient.SqlClient;
  const planFiles = yield* PlanFileService;
  const filePlan = (threadId: ThreadId) => planFiles.forThread(threadId);
  const lock = Semaphore.makeUnsafe(1);
  const source = (input: ThreadResumeFromPlanInput) =>
    Effect.gen(function* () {
      const projection = yield* threads
        .getThreadRecords(
          input.threadId,
          ["plans", "runs", "providerSessions", "providerTurns", "messages", "turnItems"],
          {
            messageRoles: ["assistant"],
            turnItemTypes: ["command_execution", "file_change", "dynamic_tool", "error"],
          },
        )
        .pipe(Effect.mapError(unavailable));
      return projection;
    });
  const eligible = (
    projection: Pick<
      OrchestrationV2ThreadProjection,
      "thread" | "plans" | "runs" | "providerSessions" | "providerTurns"
    >,
  ) =>
    Effect.gen(function* () {
      const found = yield* filePlan(projection.thread.id);
      const reason = threadResumeRefusal({
        ...(found ? { filePlan: found.summary } : {}),
        settledOverride: projection.thread.settledOverride,
        todoProgress: threadTodoProgress(projection.plans, projection.runs),
        planResumeState: threadPlanResumeState(projection),
      });
      if (reason)
        return yield* new ThreadResumeError({
          reason,
          message: `Cannot resume thread from plan: ${reason}.`,
        });
      return found;
    });
  const preview = (input: ThreadResumeFromPlanInput) =>
    source(input).pipe(
      Effect.flatMap((projection) =>
        eligible(projection).pipe(
          Effect.map((found) => ({
            seed: found ? buildFilePlanResumeSeed(found) : buildThreadResumeSeed(projection).seed,
          })),
        ),
      ),
    );
  const resume = (input: ThreadResumeFromPlanInput) =>
    lock.withPermits(1)(
      Effect.gen(function* () {
        const projection = yield* source(input);
        const thread = projection.thread;
        const lastRunId = projection.runs.toSorted((a, b) => b.ordinal - a.ordinal)[0]?.id ?? null;
        // The launch receipt and thread ID survive process exits between creation and metadata write.
        const keyInput = yield* encodeResumeKey([thread.id, lastRunId]).pipe(
          Effect.mapError(unavailable),
        );
        const key = Hex.encode(
          yield* crypto
            .digest("SHA-256", new TextEncoder().encode(keyInput))
            .pipe(Effect.mapError(unavailable)),
        );
        const newThreadId = ThreadId.make(`thread:resume-plan:${key}`);
        const existing = yield* threads
          .getThreadShell(newThreadId)
          .pipe(Effect.mapError(unavailable));
        const provenance = { threadId: thread.id, lastRunId };
        const metadata = yield* readMetadata(sql, newThreadId).pipe(Effect.mapError(unavailable));
        const settleSource = threads
          .settleThread({
            commandId: CommandId.make(`resume-plan:${key}:settle-source`),
            threadId: thread.id,
            byOwnAgent: false,
          })
          .pipe(Effect.mapError(unavailable));
        if (existing && existing.deletedAt === null && metadata?.resumedFrom) {
          return { newThreadId, reused: true };
        }
        const receipts = yield* sql<{
          command_type: string;
        }>`SELECT command_type FROM orchestration_command_receipts WHERE command_id = ${`resume-plan:${key}`} LIMIT 1`.pipe(
          Effect.mapError(unavailable),
        );
        if (existing?.deletedAt != null || (!existing && receipts.length > 0))
          return yield* new ThreadResumeError({
            reason: "unavailable",
            message: "The resumed thread was deleted; plan recovery cannot replay it.",
          });
        const foundPlan = yield* eligible(projection);
        const sourceMetadata = yield* readMetadata(sql, thread.id).pipe(
          Effect.mapError(unavailable),
        );
        yield* launches
          .launch({
            commandId: CommandId.make(`resume-plan:${key}`),
            threadId: newThreadId,
            projectId: thread.projectId,
            reusePreparedWorkspace: true,
            title: `Resume: ${thread.title}`,
            generateTitle: false,
            modelSelection: input.modelSelection ?? thread.modelSelection,
            runtimeMode: thread.runtimeMode,
            interactionMode: thread.interactionMode,
            workspaceStrategy:
              thread.worktreePath === null
                ? { type: "root", ...(thread.branch === null ? {} : { branch: thread.branch }) }
                : {
                    type: "existing_worktree",
                    worktreePath: thread.worktreePath,
                    ...(thread.branch === null ? {} : { branch: thread.branch }),
                  },
            initialMessage: {
              text: foundPlan
                ? buildFilePlanResumeSeed(foundPlan)
                : buildThreadResumeSeed(projection).seed,
              attachments: [],
            },
            createdBy: "user",
            creationSource: "server",
          })
          .pipe(Effect.mapError(unavailable));
        const currentMetadata = yield* readMetadata(sql, newThreadId).pipe(
          Effect.mapError(unavailable),
        );
        yield* writeMetadata(sql, {
          ...currentMetadata,
          threadId: newThreadId,
          parentThreadId: sourceMetadata?.parentThreadId ?? null,
          ...(sourceMetadata?.purpose === undefined ? {} : { purpose: sourceMetadata.purpose }),
          ...(sourceMetadata?.subproject === undefined
            ? {}
            : { subproject: sourceMetadata.subproject }),
          ...(sourceMetadata?.settleOnComplete === undefined
            ? {}
            : { settleOnComplete: sourceMetadata.settleOnComplete }),
          ...(sourceMetadata?.remoteParent === undefined
            ? {}
            : { remoteParent: sourceMetadata.remoteParent }),
          resumedFrom: provenance,
        }).pipe(Effect.mapError(unavailable));
        yield* settleSource;
        return { newThreadId, reused: existing !== null };
      }),
    );
  return ThreadResumeService.of({ preview, resume });
});
export const layer = Layer.effect(ThreadResumeService, make);
