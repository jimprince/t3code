import {
  CommandId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationReadModel,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";

import { decideOrchestrationCommand } from "./decider.ts";

const NOW = "2026-01-01T00:00:00.000Z";
const EARLIER = "1969-12-30T00:00:00.000Z";

function makeReadModel(input: {
  readonly sidebarOrderKey?: string | null;
  readonly pinnedAt?: string | null;
  readonly archivedAt?: string | null;
}): OrchestrationReadModel {
  return {
    snapshotSequence: 0,
    projects: [],
    threads: [
      {
        id: ThreadId.make("thread-1"),
        projectId: ProjectId.make("project-1"),
        title: "Thread",
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        latestTurn: null,
        createdAt: EARLIER,
        updatedAt: EARLIER,
        archivedAt: input.archivedAt ?? null,
        settledOverride: null,
        settledAt: null,
        snoozedUntil: null,
        snoozedAt: null,
        pinnedAt: input.pinnedAt ?? null,
        pinOrderKey: null,
        sidebarOrderKey: input.sidebarOrderKey ?? null,
        deletedAt: null,
        messages: [],
        proposedPlans: [],
        activities: [],
        checkpoints: [],
        session: null,
      },
    ],
    updatedAt: NOW,
  };
}

it.layer(NodeServices.layer)("sidebar order decider", (it) => {
  it.effect("places a thread, stamping the key and a fresh updatedAt", () =>
    Effect.gen(function* () {
      const event = yield* decideOrchestrationCommand({
        command: {
          type: "thread.sidebar.reorder",
          commandId: CommandId.make("cmd-place"),
          threadId: ThreadId.make("thread-1"),
          orderKey: "mm",
        },
        readModel: makeReadModel({}),
      });
      const events = Array.isArray(event) ? event : [event];
      expect(events).toHaveLength(1);
      expect(events[0]?.type).toBe("thread.sidebar-reordered");
      if (events[0]?.type === "thread.sidebar-reordered") {
        expect(events[0].payload.orderKey).toBe("mm");
        expect(events[0].payload.updatedAt).not.toBe(EARLIER);
      }
    }),
  );

  it.effect("clears a placement when the order key is null", () =>
    Effect.gen(function* () {
      const event = yield* decideOrchestrationCommand({
        command: {
          type: "thread.sidebar.reorder",
          commandId: CommandId.make("cmd-clear"),
          threadId: ThreadId.make("thread-1"),
          orderKey: null,
        },
        readModel: makeReadModel({ sidebarOrderKey: "mm" }),
      });
      const events = Array.isArray(event) ? event : [event];
      expect(events[0]?.type).toBe("thread.sidebar-reordered");
      if (events[0]?.type === "thread.sidebar-reordered") {
        expect(events[0].payload.orderKey).toBeNull();
        expect(events[0].payload.updatedAt).not.toBe(EARLIER);
      }
    }),
  );

  it.effect("re-dropping on the same slot preserves updatedAt so it projects as a no-op", () =>
    Effect.gen(function* () {
      const event = yield* decideOrchestrationCommand({
        command: {
          type: "thread.sidebar.reorder",
          commandId: CommandId.make("cmd-duplicate"),
          threadId: ThreadId.make("thread-1"),
          orderKey: "mm",
        },
        readModel: makeReadModel({ sidebarOrderKey: "mm" }),
      });
      const events = Array.isArray(event) ? event : [event];
      expect(events[0]?.type).toBe("thread.sidebar-reordered");
      if (events[0]?.type === "thread.sidebar-reordered") {
        expect(events[0].payload.updatedAt).toBe(EARLIER);
      }
    }),
  );

  it.effect("clearing an already-unplaced thread preserves updatedAt", () =>
    Effect.gen(function* () {
      const event = yield* decideOrchestrationCommand({
        command: {
          type: "thread.sidebar.reorder",
          commandId: CommandId.make("cmd-clear-noop"),
          threadId: ThreadId.make("thread-1"),
          orderKey: null,
        },
        readModel: makeReadModel({}),
      });
      const events = Array.isArray(event) ? event : [event];
      expect(events[0]?.type).toBe("thread.sidebar-reordered");
      if (events[0]?.type === "thread.sidebar-reordered") {
        expect(events[0].payload.updatedAt).toBe(EARLIER);
      }
    }),
  );

  // The inbox key is independent of the pin, so a thread that is currently
  // pinned may still carry the placement it will use when unpinned. Unlike
  // thread.pin.reorder there is no membership precondition to protect.
  it.effect("accepts a placement for a pinned thread", () =>
    Effect.gen(function* () {
      const event = yield* decideOrchestrationCommand({
        command: {
          type: "thread.sidebar.reorder",
          commandId: CommandId.make("cmd-pinned"),
          threadId: ThreadId.make("thread-1"),
          orderKey: "mm",
        },
        readModel: makeReadModel({ pinnedAt: EARLIER }),
      });
      const events = Array.isArray(event) ? event : [event];
      expect(events[0]?.type).toBe("thread.sidebar-reordered");
    }),
  );

  it.effect("rejects a placement for an archived thread", () =>
    Effect.gen(function* () {
      const result = yield* Effect.exit(
        decideOrchestrationCommand({
          command: {
            type: "thread.sidebar.reorder",
            commandId: CommandId.make("cmd-archived"),
            threadId: ThreadId.make("thread-1"),
            orderKey: "mm",
          },
          readModel: makeReadModel({ archivedAt: NOW }),
        }),
      );
      expect(Exit.isFailure(result)).toBe(true);
    }),
  );
});
