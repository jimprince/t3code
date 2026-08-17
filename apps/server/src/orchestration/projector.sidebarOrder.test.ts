import {
  CommandId,
  EventId,
  ProjectId,
  ThreadId,
  type OrchestrationEvent,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { createEmptyReadModel, projectEvent } from "./projector.ts";

const NOW = "2026-01-01T00:00:00.000Z";

function makeEvent(input: {
  readonly sequence: number;
  readonly type: OrchestrationEvent["type"];
  readonly payload: unknown;
}): OrchestrationEvent {
  return {
    sequence: input.sequence,
    eventId: EventId.make(`event-${input.sequence}`),
    type: input.type,
    aggregateKind: "thread",
    aggregateId: ThreadId.make("thread-1"),
    occurredAt: NOW,
    commandId: CommandId.make(`command-${input.sequence}`),
    causationEventId: null,
    correlationId: null,
    metadata: {},
    payload: input.payload as never,
  } as OrchestrationEvent;
}

const createdEvent = makeEvent({
  sequence: 1,
  type: "thread.created",
  payload: {
    threadId: ThreadId.make("thread-1"),
    projectId: ProjectId.make("project-1"),
    title: "Thread",
    modelSelection: { provider: "codex", model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    createdAt: NOW,
    updatedAt: NOW,
  },
});

it.effect("projects an inbox placement and its removal", () =>
  Effect.gen(function* () {
    const created = yield* projectEvent(createEmptyReadModel(NOW), createdEvent);
    expect(created.threads[0]?.sidebarOrderKey ?? null).toBeNull();

    const placed = yield* projectEvent(
      created,
      makeEvent({
        sequence: 2,
        type: "thread.sidebar-reordered",
        payload: { threadId: ThreadId.make("thread-1"), orderKey: "mm", updatedAt: NOW },
      }),
    );
    expect(placed.threads[0]?.sidebarOrderKey).toBe("mm");

    const cleared = yield* projectEvent(
      placed,
      makeEvent({
        sequence: 3,
        type: "thread.sidebar-reordered",
        payload: { threadId: ThreadId.make("thread-1"), orderKey: null, updatedAt: NOW },
      }),
    );
    expect(cleared.threads[0]?.sidebarOrderKey).toBeNull();
  }),
);

// The inbox placement is a separate field from pinOrderKey precisely so a
// pin/unpin round trip cannot spend it: unpin clears the PIN slot only.
it.effect("keeps the inbox placement across a pin and unpin", () =>
  Effect.gen(function* () {
    const created = yield* projectEvent(createEmptyReadModel(NOW), createdEvent);
    const placed = yield* projectEvent(
      created,
      makeEvent({
        sequence: 2,
        type: "thread.sidebar-reordered",
        payload: { threadId: ThreadId.make("thread-1"), orderKey: "mm", updatedAt: NOW },
      }),
    );
    const pinned = yield* projectEvent(
      placed,
      makeEvent({
        sequence: 3,
        type: "thread.pinned",
        payload: {
          threadId: ThreadId.make("thread-1"),
          pinnedAt: NOW,
          pinOrderKey: "ff",
          updatedAt: NOW,
        },
      }),
    );
    const unpinned = yield* projectEvent(
      pinned,
      makeEvent({
        sequence: 4,
        type: "thread.unpinned",
        payload: { threadId: ThreadId.make("thread-1"), updatedAt: NOW },
      }),
    );
    expect(unpinned.threads[0]?.pinOrderKey ?? null).toBeNull();
    expect(unpinned.threads[0]?.sidebarOrderKey).toBe("mm");
  }),
);
