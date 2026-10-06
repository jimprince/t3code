import {
  CommandId,
  ForkConversationError,
  ForkConversationInput,
  type ForkConversationResult,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";
import * as KeyedLock from "@t3tools/shared/KeyedLock";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as GitWorkflow from "../git/GitWorkflowService.ts";
import * as Projects from "../project/ProjectService.ts";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import * as Receipts from "../orchestration-v2/CommandReceiptStore.ts";
import * as PortableHistory from "./PortableHistory.ts";

const encodeForkInput = Schema.encodeEffect(Schema.fromJsonString(ForkConversationInput));

export class ForkWorkspaceService extends Context.Service<
  ForkWorkspaceService,
  {
    readonly fork: (
      input: ForkConversationInput,
    ) => Effect.Effect<ForkConversationResult, ForkConversationError>;
  }
>()("t3/forkThreads/ForkWorkspaceService") {}
const make = Effect.gen(function* () {
  const threads = yield* Threads.ThreadManagementService;
  const projects = yield* Projects.ProjectService;
  const git = yield* GitWorkflow.GitWorkflowService;
  const history = yield* PortableHistory.PortableHistory;
  const receipts = yield* Receipts.CommandReceiptStoreV2;
  const sql = yield* SqlClient.SqlClient;
  const locks = yield* KeyedLock.make<string>();
  const fork = Effect.fn("ForkWorkspaceService.fork")(function* (input: ForkConversationInput) {
    if (input.sourceThreadId === input.targetThreadId)
      return yield* new ForkConversationError({
        operation: "validate",
        cause: "A fork must have a new identity.",
      });
    yield* sql`CREATE TABLE IF NOT EXISTS fork_workspace_receipts (command_id TEXT PRIMARY KEY, target_id TEXT NOT NULL, workspace_mode TEXT NOT NULL, worktree_path TEXT)`;
    yield* sql`CREATE TABLE IF NOT EXISTS fork_workspace_requests (command_id TEXT PRIMARY KEY, input_json TEXT NOT NULL)`;
    const signature = yield* encodeForkInput(input);
    const requests = yield* sql<{
      input_json: string;
    }>`SELECT input_json FROM fork_workspace_requests WHERE command_id = ${input.commandId}`;
    if (requests[0] && requests[0].input_json !== signature)
      return yield* new ForkConversationError({
        operation: "validate",
        cause: "Fork command parameters changed.",
      });
    yield* sql`INSERT OR IGNORE INTO fork_workspace_requests VALUES (${input.commandId}, ${signature})`;
    const completed = yield* sql<{
      target_id: string;
      workspace_mode: string;
      worktree_path: string | null;
    }>`SELECT * FROM fork_workspace_receipts WHERE command_id = ${input.commandId}`;
    if (completed[0]) {
      if (
        completed[0].target_id !== input.targetThreadId ||
        completed[0].workspace_mode !== input.workspaceMode
      )
        return yield* new ForkConversationError({
          operation: "validate",
          cause: "Fork receipt identity changed.",
        });
      return { threadId: input.targetThreadId, worktreePath: completed[0].worktree_path };
    }
    const source = yield* threads.getThreadProjection(input.sourceThreadId);
    const project = yield* projects.getById(source.thread.projectId);
    if (Option.isNone(project))
      return yield* new ForkConversationError({
        operation: "validate",
        cause: "Source project is missing.",
      });
    if (project.value.kind === "chat" && input.workspaceMode === "new-worktree")
      return yield* new ForkConversationError({
        operation: "validate",
        cause: "General Chat has no worktree.",
      });
    const prior = yield* receipts.getByCommandId(input.commandId);
    if (
      Option.isSome(prior) &&
      (prior.value.threadId !== input.targetThreadId ||
        prior.value.status !== "accepted" ||
        !["thread.fork", "fork.history.import"].includes(prior.value.commandType))
    )
      return yield* new ForkConversationError({
        operation: "validate",
        cause: "Fork command identity changed or was rejected.",
      });
    if (Option.isNone(prior)) {
      if (source.runs.length === 0 && source.thread.historyOrigin === "v1_import") {
        if (input.sourcePoint.type !== "latest_stable")
          return yield* new ForkConversationError({
            operation: "validate",
            cause: "Imported history has no native run or checkpoint boundary.",
          });
        const now = yield* DateTime.now;
        yield* history.import({
          commandId: input.commandId,
          messages: source.messages,
          thread: {
            ...source.thread,
            id: input.targetThreadId,
            title: input.title ?? `${source.thread.title} fork`,
            createdBy: "user",
            creationSource: "server",
            activeProviderThreadId: null,
            lineage: {
              parentThreadId: source.thread.id,
              relationshipToParent: "fork",
              rootThreadId: source.thread.lineage.rootThreadId,
            },
            forkedFrom: null,
            createdAt: now,
            updatedAt: now,
            archivedAt: null,
            deletedAt: null,
            settledOverride: null,
            settledAt: null,
            snoozedAt: null,
            snoozedUntil: null,
            lastVisitedAt: null,
          },
        });
      } else {
        yield* threads.dispatch({
          type: "thread.fork",
          commandId: input.commandId,
          sourceThreadId: input.sourceThreadId,
          targetThreadId: input.targetThreadId,
          sourcePoint: input.sourcePoint,
          ...(input.title === undefined ? {} : { title: input.title }),
          createdBy: "user",
          creationSource: "server",
        });
      }
    }
    let worktreePath = source.thread.worktreePath;
    if (input.workspaceMode === "new-worktree") {
      const sourcePoint = input.sourcePoint;
      const target = yield* threads.getThreadProjection(input.targetThreadId);
      const forkedFrom = target.thread.forkedFrom;
      const run =
        forkedFrom?.type === "run"
          ? source.runs.find((run) => run.id === forkedFrom.runId)
          : undefined;
      const checkpoint =
        sourcePoint.type === "checkpoint"
          ? source.checkpoints.find(
              (checkpoint) =>
                checkpoint.id === sourcePoint.checkpointId && checkpoint.status === "ready",
            )
          : source.checkpoints.findLast(
              (checkpoint) => checkpoint.runId === run?.id && checkpoint.status === "ready",
            );
      const baseRef = checkpoint?.ref ?? source.thread.branch ?? "HEAD";
      const branch = `t3-fork-${input.targetThreadId.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
      yield* sql`CREATE TABLE IF NOT EXISTS fork_workspace_claims (target_id TEXT PRIMARY KEY, branch TEXT NOT NULL)`;
      const claims = yield* sql<{
        branch: string;
      }>`SELECT branch FROM fork_workspace_claims WHERE target_id = ${input.targetThreadId}`;
      // Only an existing durable ownership claim permits worktree reuse.
      const listed = yield* git.listRefs({
        cwd: project.value.workspaceRoot,
        query: branch,
        refKind: "local",
        refresh: true,
        limit: 100,
      });
      const existing = listed.refs.find((ref) => ref.name === branch);
      if (existing && !claims[0])
        return yield* new ForkConversationError({
          operation: "validate",
          cause: "Fork branch belongs to another operation.",
        });
      yield* sql`INSERT OR IGNORE INTO fork_workspace_claims VALUES (${input.targetThreadId}, ${branch})`;
      const tree = existing?.worktreePath
        ? { path: existing.worktreePath }
        : (yield* git.createWorktree({
            cwd: project.value.workspaceRoot,
            refName: existing ? branch : baseRef,
            ...(existing ? {} : { newRefName: branch }),
            baseRefName: source.thread.branch ?? "HEAD",
            path: null,
          })).worktree;
      worktreePath = tree.path;
      yield* threads.dispatch({
        type: "thread.metadata.update",
        commandId: CommandId.make(`${input.commandId}:workspace`),
        threadId: input.targetThreadId,
        branch,
        worktreePath,
      });
    }
    yield* sql`INSERT INTO fork_workspace_receipts VALUES (${input.commandId}, ${input.targetThreadId}, ${input.workspaceMode}, ${worktreePath})`;
    return { threadId: input.targetThreadId, worktreePath };
  });
  return ForkWorkspaceService.of({
    fork: (input) =>
      locks
        .withLock(input.targetThreadId, fork(input))
        .pipe(
          Effect.mapError(
            (cause) => new ForkConversationError({ operation: "prepare-workspace", cause }),
          ),
        ),
  });
});
export const layer = Layer.effect(ForkWorkspaceService, make);
