import { assert, it } from "@effect/vitest";
import {
  EventId,
  ProjectId,
  ProviderInstanceId,
  RuntimeRequestId,
  NodeId,
  ThreadId,
  OrchestrationV2AppThread,
  type OrchestrationV2DomainEvent,
  type ThreadPullRequestLink,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import { observationsForEvent } from "./AgentGateway.ts";
import { eventsFor } from "./events.ts";

const now = DateTime.makeUnsafe("2026-10-06T00:00:00Z");
const thread = OrchestrationV2AppThread.make({
  id: ThreadId.make("root"),
  projectId: ProjectId.make("project"),
  title: "Root",
  providerInstanceId: ProviderInstanceId.make("codex"),
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "test" },
  createdBy: "system",
  creationSource: "server",
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  activeProviderThreadId: null,
  lineage: {
    parentThreadId: null,
    relationshipToParent: null,
    rootThreadId: ThreadId.make("root"),
  },
  forkedFrom: null,
  createdAt: now,
  updatedAt: now,
  archivedAt: null,
  deletedAt: null,
  settledAt: null,
  settledOverride: null,
  pinnedAt: null,
  lastVisitedAt: null,
});
const base = {
  id: EventId.make("event"),
  threadId: thread.id,
  providerInstanceId: thread.providerInstanceId,
  occurredAt: now,
};
const link: ThreadPullRequestLink = {
  host: "git.example.test",
  repository: "owner/repo",
  number: 1,
  url: "https://git.example.test/owner/repo/pulls/1",
  source: "manual",
  linkedAt: DateTime.formatIso(now),
  snapshot: null,
  stack: null,
};
const wanted = new Set(["pull-request.opened", "ci.failed", "worker.blocked"] as const);

it.effect(
  "native full-thread PR events distinguish new links, check transitions and tombstones",
  () =>
    Effect.sync(() => {
      const event: OrchestrationV2DomainEvent = {
        ...base,
        type: "thread.pull-request-synced",
        payload: { ...thread, pullRequests: [link] },
      };
      const opened = observationsForEvent(event, thread, wanted, []);
      assert.equal(opened[0]?.type, "pull-request-linked");
      assert.deepEqual(observationsForEvent(event, thread, wanted, [link]), []);
      assert.deepEqual(
        observationsForEvent(
          {
            ...event,
            payload: { ...thread, pullRequests: [{ ...link, source: "stack-dismissed" }] },
          },
          thread,
          wanted,
          [],
        ),
        [],
      );
      const failing = {
        ...link,
        snapshot: {
          state: "open" as const,
          title: "PR",
          headBranch: "feature",
          baseBranch: "main",
          isDraft: false,
          updatedAt: null,
          syncedAt: DateTime.formatIso(now),
          checksState: "failing" as const,
        },
      };
      const checks = observationsForEvent(
        { ...event, payload: { ...thread, pullRequests: [failing] } },
        thread,
        wanted,
        [link],
      );
      assert.equal(checks.length, 1);
      assert.equal(checks[0]?.type, "pull-request-checks");
      assert.equal(eventsFor(checks[0]!, undefined).events[0]?.kind, "ci.failed");
      assert.deepEqual(eventsFor(checks[0]!, "failing").events, []);
      assert.deepEqual(
        observationsForEvent(
          { ...event, payload: { ...thread, pullRequests: [failing] } },
          thread,
          wanted,
          [failing],
        ),
        [],
      );
      assert.deepEqual(observationsForEvent(event, thread, new Set(), []), []);
    }),
);

it.effect(
  "pending approval and input retain request identity, while resolved and internal requests do not fire",
  () =>
    Effect.sync(() => {
      const request = {
        id: RuntimeRequestId.make("request"),
        nodeId: NodeId.make("node"),
        providerTurnId: null,
        nativeRequestRef: null,
        kind: "user_input" as const,
        status: "pending" as const,
        responseCapability: { type: "message" as const },
        createdAt: now,
        resolvedAt: null,
      };
      const event: OrchestrationV2DomainEvent = {
        ...base,
        type: "runtime-request.updated",
        payload: request,
      };
      assert.deepEqual(observationsForEvent(event, thread, wanted), [
        {
          type: "thread-waiting",
          projectId: thread.projectId,
          threadId: thread.id,
          title: "Root",
          reason: "input",
          requestId: "request",
          at: DateTime.formatIso(now),
        },
      ]);
      const approval = observationsForEvent(
        { ...event, payload: { ...request, kind: "command" } },
        thread,
        wanted,
      );
      assert.equal(approval[0]?.type === "thread-waiting" ? approval[0].reason : null, "approval");
      assert.deepEqual(
        observationsForEvent(
          { ...event, payload: { ...request, status: "resolved" } },
          thread,
          wanted,
        ),
        [],
      );
      assert.deepEqual(
        observationsForEvent(
          { ...event, payload: { ...request, kind: "dynamic_tool_call" } },
          thread,
          wanted,
        ),
        [],
      );
    }),
);
