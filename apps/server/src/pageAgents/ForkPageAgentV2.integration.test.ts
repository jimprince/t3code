import { assert, it } from "@effect/vitest";
import {
  EventId,
  MessageId,
  makePageAgentThreadId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  withoutPageAgentThreads,
  type OrchestrationV2DomainEvent,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import type { ShellApplicationEvent } from "../orchestration-v2/ShellStream.ts";
import * as ThreadSearch from "../orchestration-v2/ThreadSearch.ts";
import {
  isPageAgentShellEvent,
  withoutPageAgentMatches,
  withoutPageAgentShellEvents,
} from "./PageAgentVisibilityPolicy.ts";

const TestLayer = Layer.mergeAll(
  ThreadSearch.layer,
  ProjectionStore.layer,
  ProjectStore.layer,
).pipe(Layer.provideMerge(SqlitePersistenceMemory));

const providerInstanceId = ProviderInstanceId.make("codex");
const at = (minute: number) => DateTime.makeUnsafe(Date.UTC(2026, 9, 6, 0, minute));

const createProject = (projectId: ProjectId) =>
  Effect.flatMap(ProjectStore.ProjectStoreV2, (projects) =>
    projects.apply({
      sequence: 0,
      eventId: EventId.make(`created:${projectId}`),
      aggregateKind: "project",
      aggregateId: projectId,
      occurredAt: DateTime.formatIso(at(0)),
      commandId: null,
      causationEventId: null,
      correlationId: null,
      metadata: {},
      type: "project.created",
      payload: {
        projectId,
        title: projectId,
        workspaceRoot: `/work/${projectId}`,
        defaultModelSelection: null,
        scripts: [],
        createdAt: DateTime.formatIso(at(0)),
        updatedAt: DateTime.formatIso(at(0)),
      },
    }),
  );

const threadCreated = (threadId: ThreadId, projectId: ProjectId): OrchestrationV2DomainEvent => ({
  id: EventId.make(`created:${threadId}`),
  type: "thread.created",
  threadId,
  providerInstanceId,
  occurredAt: at(0),
  payload: {
    createdBy: "user",
    creationSource: "web",
    id: threadId,
    projectId,
    title: threadId,
    providerInstanceId,
    modelSelection: { instanceId: providerInstanceId, model: "gpt-5" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
    forkedFrom: null,
    createdAt: at(0),
    updatedAt: at(0),
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
  },
});

const userMessage = (threadId: ThreadId, id: string, text: string): OrchestrationV2DomainEvent => ({
  id: EventId.make(`message:${id}`),
  type: "message.updated",
  threadId,
  providerInstanceId,
  occurredAt: at(1),
  payload: {
    createdBy: "user",
    creationSource: "web",
    id: MessageId.make(id),
    threadId,
    runId: null,
    nodeId: null,
    role: "user",
    text,
    attachments: [],
    streaming: false,
    createdAt: at(1),
    updatedAt: at(1),
  },
});

it.layer(TestLayer)("page agent visibility on V2", (it) => {
  it.effect("search keeps page-agent threads internally and the public filter hides them", () =>
    Effect.gen(function* () {
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const search = yield* ThreadSearch.ThreadSearch;
      const project = ProjectId.make("project:page-agent-chat");
      yield* createProject(project);
      const pageAgent = ThreadId.make(makePageAgentThreadId("status-board", "4c1e"));
      const ordinary = ThreadId.make("thread:ordinary");
      yield* Effect.forEach(
        [
          threadCreated(pageAgent, project),
          userMessage(pageAgent, "page-agent-message", "tray needle question"),
          threadCreated(ordinary, project),
          userMessage(ordinary, "ordinary-message", "ordinary needle question"),
        ],
        projections.apply,
        { discard: true },
      );

      const internal = yield* search.search({ query: "needle", limit: 20 });
      assert.sameMembers(
        internal.matches.map((match) => match.threadId),
        [pageAgent, ordinary],
      );
      const publicResult = withoutPageAgentMatches(internal);
      assert.deepEqual(
        publicResult.matches.map((match) => match.threadId),
        [ordinary],
      );
    }),
  );
});

const threadEvent = (threadId: string): ShellApplicationEvent => ({
  sequence: 1,
  event: { threadId: ThreadId.make(threadId) },
});

it.effect(
  "the live shell feed drops page-agent thread events and keeps project and thread ones",
  () =>
    Effect.gen(function* () {
      const pageAgent = makePageAgentThreadId("status-board", "4c1e");
      const project: ShellApplicationEvent = {
        aggregateKind: "project",
        aggregateId: ProjectId.make("project:a"),
        type: "project.meta-updated",
        sequence: 3,
      };
      const events = [threadEvent("thread:a"), threadEvent(pageAgent), project];
      assert.deepEqual(events.map(isPageAgentShellEvent), [false, true, false]);
      const visible = yield* Stream.runCollect(
        withoutPageAgentShellEvents(Stream.fromIterable(events)),
      );
      assert.deepEqual(Array.from(visible), [events[0], events[2]]);
    }),
);

it("snapshots drop page-agent threads from the active and archived lists", () => {
  const pageAgent = makePageAgentThreadId("status-board", "4c1e");
  const snapshot = {
    schemaVersion: 1,
    threads: [{ id: "thread:a" }, { id: pageAgent }],
    archivedThreads: [{ id: pageAgent }, { id: "thread:b" }],
  };
  assert.deepEqual(withoutPageAgentThreads(snapshot), {
    schemaVersion: 1,
    threads: [{ id: "thread:a" }],
    archivedThreads: [{ id: "thread:b" }],
  });
});
