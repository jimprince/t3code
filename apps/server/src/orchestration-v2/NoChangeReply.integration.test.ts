import { assert, it } from "@effect/vitest";
import {
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type OrchestrationV2AppThread,
  type OrchestrationV2Run,
} from "@t3tools/contracts";
import { projectThreadAwarenessV2 } from "@t3tools/shared/agentAwareness";
import { EnvironmentId } from "@t3tools/contracts";
import { threadNotificationEvent } from "@t3tools/client-runtime/notification-eligibility";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import { readWorkerSummaries } from "../forkThreads/WorkerSummaryService.ts";
import { layerMemory as SqlitePersistenceMemory } from "../persistence/Sqlite.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import { answerToMessage } from "../projectIssues/requestLedger.logic.ts";

const cases = [
  ["No change.", true],
  ["Nothing new for you.", true],
  [" \n\tNo change.\r\n ", true],
  [`${" \n".repeat(80)}Nothing new for you.\u00a0`, true],
  ["No change. More text.", false],
  ["No change.\n\nAnother paragraph.", false],
  ["No change. T3_NOTIFY: quiet", false],
  ["Nothing new for you. T3_NOTIFY: quiet", false],
  ["no change", false],
  ["**No change.**", false],
  ["We found No change. in the log.", false],
  [`${"Meaningful work. ".repeat(20)}${" ".repeat(70)}No change.`, false],
] as const;

for (const storage of ["sqlite", "memory"] as const) {
  it.effect.each(cases.map(([text, silent], key) => ({ text, silent, key })))(
    `${storage}: final reply %j preserves the timeline and suppresses only exact matches`,
    ({ text, silent, key }) =>
      Effect.gen(function* () {
        const store = yield* ProjectionStore.ProjectionStoreV2;
        const now = yield* DateTime.now;
        const threadId = ThreadId.make(`thread:no-change:${key}`);
        const runId = RunId.make(`run:no-change:${key}`);
        const askedId = MessageId.make(`message:asked:${key}`);
        const replyId = MessageId.make(`message:reply:${key}`);
        const instanceId = ProviderInstanceId.make("codex");
        const thread: OrchestrationV2AppThread = {
          id: threadId,
          projectId: ProjectId.make("project:no-change"),
          title: "Reply suppression",
          providerInstanceId: instanceId,
          modelSelection: { instanceId, model: "test" },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          activeProviderThreadId: null,
          lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
          forkedFrom: null,
          createdBy: "user",
          creationSource: "web",
          createdAt: now,
          updatedAt: now,
          archivedAt: null,
          settledOverride: null,
          settledAt: null,
          lastVisitedAt: null,
          deletedAt: null,
        };
        const run: OrchestrationV2Run = {
          id: runId,
          threadId,
          ordinal: 1,
          providerInstanceId: instanceId,
          modelSelection: thread.modelSelection,
          providerThreadId: null,
          userMessageId: askedId,
          rootNodeId: null,
          activeAttemptId: null,
          status: "completed",
          requestedAt: now,
          startedAt: now,
          completedAt: now,
          checkpointId: null,
          contextHandoffId: null,
        };
        yield* store.apply({
          id: EventId.make(`event:thread:${key}`),
          type: "thread.created",
          threadId,
          occurredAt: now,
          payload: thread,
        });
        yield* store.apply({
          id: EventId.make(`event:run:${key}`),
          type: "run.created",
          threadId,
          runId,
          occurredAt: now,
          payload: run,
        });
        for (const [id, role, value] of [
          [askedId, "user", "Check for changes."],
          [replyId, "assistant", text],
        ] as const) {
          yield* store.apply({
            id: EventId.make(`event:${id}`),
            type: "message.updated",
            threadId,
            runId,
            occurredAt: now,
            payload: {
              id,
              threadId,
              runId,
              nodeId: null,
              role,
              text: value,
              attachments: [],
              streaming: false,
              createdBy: role === "user" ? "user" : "agent",
              creationSource: "web",
              createdAt: now,
              updatedAt: now,
            },
          });
        }
        if (storage === "sqlite") {
          const summaries = yield* readWorkerSummaries(yield* SqlClient.SqlClient, [threadId]);
          const summary = summaries.get(threadId);
          assert.isDefined(summary);
          assert.equal(summary!.output === null, silent);
          assert.equal(summary!.messageCount, 2);
        }
        const projection = yield* store.getThreadProjection(threadId);
        assert.equal(projection.messages.find((message) => message.id === replyId)?.text, text);
        const answer = answerToMessage(
          projection.messages.map((message) => ({
            messageId: message.id,
            turnId: message.runId,
            role: message.role,
            text: message.text,
            isStreaming: message.streaming,
            createdAt: DateTime.formatIso(message.createdAt),
          })),
          askedId,
        );
        assert.equal(answer?.text ?? null, silent ? null : text.trim());
        const shell = yield* store.getThreadShell(threadId);
        const snapshotShell = (yield* store.getShellSnapshot()).threads.find(
          (row) => row.id === threadId,
        );
        const projectedShell = ProjectionStore.threadShellFromProjection(projection);
        for (const value of [shell, snapshotShell, projectedShell]) {
          assert.isDefined(value);
          assert.equal(value!.notificationDisposition, silent ? "quiet" : null);
          assert.equal(threadNotificationEvent(value!)?.kind ?? null, silent ? null : "reply");
          assert.equal(
            projectThreadAwarenessV2({
              environmentId: EnvironmentId.make("env"),
              project: { title: "Project" },
              thread: value!,
            })?.phase ?? null,
            silent ? null : "completed",
          );
        }
      }).pipe(
        Effect.provide(
          storage === "sqlite"
            ? Layer.mergeAll(
                SqlitePersistenceMemory,
                ProjectionStore.layer.pipe(Layer.provide(SqlitePersistenceMemory)),
              )
            : Layer.merge(SqlitePersistenceMemory, ProjectionStore.layerMemory),
        ),
      ),
  );
}
