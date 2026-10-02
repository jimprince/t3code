import { DateTime } from "effect";
import type { OrchestrationV2ThreadProjection, OrchestrationV2Run } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { threadDetail, threadShell } from "../src/v2/reads.js";
import { withThreadMetadata } from "../src/v2/nesting.js";
import { classifyThread, selectThreadChildren } from "../src/status.js";
import { scanAttentionNotifications } from "../src/watch.js";
import type { StateFile } from "../src/types.js";
const date = DateTime.makeUnsafe("2026-10-05T00:00:00Z");
function run(id: string, ordinal: number, status: string, queueHeld = false) {
  return {
    id,
    ordinal,
    status,
    queueHeld,
    requestedAt: date,
    startedAt: status === "queued" ? null : date,
    completedAt: status === "completed" ? date : null,
  } as OrchestrationV2Run;
}
function projection(runs: OrchestrationV2Run[], planStatus?: string) {
  return {
    thread: {
      id: "worker",
      projectId: "other-project",
      providerInstanceId: "cursor",
      title: "Worker",
      modelSelection: { instanceId: "cursor", model: "auto" },
      lineage: { parentThreadId: "parent" },
      createdAt: date,
      updatedAt: date,
      archivedAt: null,
      deletedAt: null,
      settledAt: null,
      unsettledAt: null,
      pinnedAt: null,
    },
    runs,
    providerSessions: [],
    runtimeRequests: [],
    turnItems: [],
    updatedAt: date,
    messages: [
      {
        id: "answer",
        role: "assistant",
        text: "Finished",
        runId: "finished",
        createdAt: date,
        updatedAt: date,
      },
    ],
    plans: planStatus
      ? [
          {
            id: "plan",
            kind: "proposed_plan",
            status: planStatus,
            markdown: "Plan",
            runId: "finished",
          },
        ]
      : [],
  } as unknown as OrchestrationV2ThreadProjection;
}
describe("native V2 notification reads", () => {
  it("never groups execution descendants without organizational metadata", () => {
    const source = projection([run("finished", 1, "completed")]);
    const detail = threadDetail(source);
    expect(detail.parentThreadId).toBeNull();
    expect(detail.executionParentThreadId).toBe("parent");
    const shell = threadShell({
      ...source.thread,
      latestRunId: "finished",
      status: "completed",
      pendingRuntimeRequest: null,
    } as Parameters<typeof threadShell>[0]);
    expect(shell.parentThreadId).toBeNull();
    expect(shell.executionParentThreadId).toBe("parent");
    expect(selectThreadChildren([shell], "parent", true)).toEqual([]);
    expect(selectThreadChildren([withThreadMetadata(shell, [])], "parent", true)).toEqual([]);
  });
  it("keeps a completed run visible across held queues and unordered records", () => {
    const thread = threadDetail(
      projection([
        run("queued", 3, "queued", true),
        run("finished", 2, "completed"),
        run("old", 1, "completed"),
      ]),
    );
    expect(thread.latestTurn?.turnId).toBe("finished");
    expect(classifyThread(thread).state).toBe("completed");
    expect(thread.session).toBeNull();
  });
  it.each([
    ["draft", "completed"],
    ["active", "needs-plan"],
    ["superseded", "completed"],
  ])("maps a %s plan to %s", (planStatus, state) => {
    expect(
      classifyThread(threadDetail(projection([run("finished", 1, "completed")], planStatus))).state,
    ).toBe(state);
  });
  it("routes completion to the stored parent across project and environment boundaries", async () => {
    const state: StateFile = {
      version: 1,
      environments: [{ name: "child-env" } as StateFile["environments"][number]],
      agents: [
        {
          name: "worker",
          threadId: "worker",
          environment: "child-env",
          projectId: "other-project",
          title: "Worker",
          createdAt: "2026-10-05",
          lastSeenAssistantMessageId: null,
        },
      ],
      subscriptions: [
        {
          subscriberThreadId: "parent",
          subscriberAgentName: "parent",
          subscriberEnvironment: "parent-env",
          sourceThreadId: "worker",
          sourceAgentName: "worker",
          sourceEnvironment: "child-env",
          createdAt: "2026-10-05",
          updatedAt: "2026-10-05",
        },
      ],
      notifications: [],
      queuedSends: [],
    };
    const thread = threadDetail(
      projection([run("finished", 1, "completed"), run("queued", 2, "queued", true)]),
    );
    const notifications = await scanAttentionNotifications(state, {
      clientFactory: () => ({ findThread: async () => thread, sendMessage: async () => {} }),
    });
    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toMatchObject({
      sourceState: "completed",
      latestTurnId: "finished",
      subscriberThreadId: "parent",
      subscriberEnvironment: "parent-env",
      sourceEnvironment: "child-env",
      preview: "Finished",
    });
  });
});
