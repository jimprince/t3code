import { CommandId, EventId, ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { OrchestrationEventStore } from "../../persistence/Services/OrchestrationEventStore.ts";
import { OrchestrationProjectionPipelineLive } from "./ProjectionPipeline.ts";
import { OrchestrationProjectionPipeline } from "../Services/ProjectionPipeline.ts";
import { ServerConfig } from "../../config.ts";

const NOW = "2026-01-01T00:00:00.000Z";

const TestLayer = OrchestrationProjectionPipelineLive.pipe(
  Layer.provideMerge(OrchestrationEventStoreLive),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-sidebar-order-test-" })),
  Layer.provideMerge(SqlitePersistenceMemory),
  Layer.provideMerge(NodeServices.layer),
);

const eventBase = (sequenceLabel: string) => ({
  eventId: EventId.make(`evt-${sequenceLabel}`),
  aggregateKind: "thread" as const,
  aggregateId: ThreadId.make("thread-1"),
  occurredAt: NOW,
  commandId: CommandId.make(`cmd-${sequenceLabel}`),
  causationEventId: null,
  correlationId: CommandId.make(`cmd-${sequenceLabel}`),
  metadata: {},
});

const readSidebarOrderKey = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly sidebarOrderKey: string | null }>`
    SELECT sidebar_order_key AS "sidebarOrderKey"
    FROM projection_threads
    WHERE thread_id = 'thread-1'
  `;
  return rows[0]?.sidebarOrderKey ?? null;
});

it.layer(TestLayer)("inbox order projection", (it) => {
  // The product promise is that a manual position survives an app restart,
  // which means it has to reach the projection table — not just the
  // in-memory read model.
  it.effect("writes and clears sidebar_order_key on the projected thread row", () =>
    Effect.gen(function* () {
      const projectionPipeline = yield* OrchestrationProjectionPipeline;
      const eventStore = yield* OrchestrationEventStore;

      yield* eventStore.append({
        ...eventBase("project"),
        type: "project.created",
        aggregateKind: "project",
        aggregateId: ProjectId.make("project-1"),
        payload: {
          projectId: ProjectId.make("project-1"),
          title: "Project 1",
          kind: "chat",
          workspaceRoot: "/tmp/project-1",
          defaultModelSelection: null,
          scripts: [],
          createdAt: NOW,
          updatedAt: NOW,
        },
      });
      yield* eventStore.append({
        ...eventBase("thread"),
        type: "thread.created",
        payload: {
          threadId: ThreadId.make("thread-1"),
          projectId: ProjectId.make("project-1"),
          title: "Thread 1",
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5-codex",
          },
          runtimeMode: "full-access",
          branch: null,
          worktreePath: null,
          createdAt: NOW,
          updatedAt: NOW,
        },
      });

      yield* projectionPipeline.bootstrap;
      assert.equal(yield* readSidebarOrderKey, null);

      yield* eventStore.append({
        ...eventBase("place"),
        type: "thread.sidebar-reordered",
        payload: {
          threadId: ThreadId.make("thread-1"),
          orderKey: "mm",
          updatedAt: NOW,
        },
      });
      yield* projectionPipeline.bootstrap;
      assert.equal(yield* readSidebarOrderKey, "mm");

      // A pin/unpin round trip clears pinOrderKey but must leave the inbox
      // placement alone — they are separate columns for exactly this reason.
      yield* eventStore.append({
        ...eventBase("pin"),
        type: "thread.pinned",
        payload: {
          threadId: ThreadId.make("thread-1"),
          pinnedAt: NOW,
          pinOrderKey: "ff",
          updatedAt: NOW,
        },
      });
      yield* eventStore.append({
        ...eventBase("unpin"),
        type: "thread.unpinned",
        payload: { threadId: ThreadId.make("thread-1"), updatedAt: NOW },
      });
      yield* projectionPipeline.bootstrap;
      assert.equal(yield* readSidebarOrderKey, "mm");

      yield* eventStore.append({
        ...eventBase("clear"),
        type: "thread.sidebar-reordered",
        payload: {
          threadId: ThreadId.make("thread-1"),
          orderKey: null,
          updatedAt: NOW,
        },
      });
      yield* projectionPipeline.bootstrap;
      assert.equal(yield* readSidebarOrderKey, null);
    }),
  );
});
