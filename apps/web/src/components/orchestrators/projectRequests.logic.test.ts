import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import type { ProjectIssue } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  deriveProjectRequests,
  deriveRelease,
  requestKind,
  requestsByWorker,
} from "./projectRequests.logic";

const NOW = Date.parse("2026-10-04T12:00:00.000Z");

function request(number: number, overrides: Partial<ProjectIssue> = {}): ProjectIssue {
  return {
    host: "git.example",
    repository: "brad/printcell",
    number,
    title: `Request ${number}`,
    url: `https://git.example/brad/printcell/issues/${number}`,
    status: "pending",
    labels: ["ask", "ask:question"],
    isRequest: true,
    requestSource: { threadId: "worker" as never, rootThreadId: "root" as never, messageId: "m" },
    assignees: [],
    comments: 0,
    createdAt: "2026-10-04T10:00:00.000Z",
    updatedAt: "2026-10-04T10:00:00.000Z",
    closedAt: null,
    linkedThreadIds: [],
    ...overrides,
  };
}

function thread(overrides: Record<string, unknown> = {}): EnvironmentThreadShell {
  return {
    id: "worker",
    runtime: null,
    pendingBackgroundTasks: [],
    latestRun: null,
    ...overrides,
  } as unknown as EnvironmentThreadShell;
}

const tree = new Set(["root", "worker"]);

describe("deriveProjectRequests", () => {
  it("puts a request the agent marked ready in Brad's group for its kind", () => {
    const [question, plan] = deriveProjectRequests(
      [
        request(1, { status: "needs-review", stage: "ready" }),
        request(2, { status: "needs-review", stage: "ready", labels: ["ask", "ask:plan"] }),
      ],
      [thread()],
      tree,
      NOW,
    );
    expect(question?.forYou).toBe("answers");
    expect(plan?.forYou).toBe("approve");
  });

  it("treats a thread reply after the request as ready even before the agent marks it", () => {
    const [item] = deriveProjectRequests(
      [request(1, { labels: ["ask", "ask:deliverable"] })],
      [
        thread({
          latestRun: { status: "completed", completedAt: "2026-10-04T11:00:00.000Z" },
        }),
      ],
      tree,
      NOW,
    );
    expect(item).toMatchObject({ forYou: "review", replied: true, leftBehind: false });
  });

  it("keeps a request with the agent while its thread is still working", () => {
    const [item] = deriveProjectRequests(
      [request(1)],
      [
        thread({
          runtime: { status: "running" },
          latestRun: { status: "completed", completedAt: "2026-10-04T11:00:00.000Z" },
        }),
      ],
      tree,
      NOW,
    );
    expect(item?.forYou).toBeNull();
  });

  it("flags a stale request on an idle thread as left behind", () => {
    const [item] = deriveProjectRequests(
      [
        request(1, {
          createdAt: "2026-10-01T00:00:00.000Z",
          updatedAt: "2026-10-01T00:00:00.000Z",
        }),
      ],
      [thread({ latestRun: { status: "completed", completedAt: "2026-09-30T00:00:00.000Z" } })],
      tree,
      NOW,
    );
    expect(item).toMatchObject({ forYou: null, leftBehind: true });
  });

  it("does not count a dev server or monitor as work in progress", () => {
    const stale = {
      createdAt: "2026-10-01T00:00:00.000Z",
      updatedAt: "2026-10-01T00:00:00.000Z",
    };
    const idleWith = (kind: string) =>
      thread({
        pendingBackgroundTasks: [{ taskId: "t1", kind }],
        latestRun: { status: "completed", completedAt: "2026-09-30T00:00:00.000Z" },
      });
    const [devServer] = deriveProjectRequests(
      [request(1, stale)],
      [idleWith("command")],
      tree,
      NOW,
    );
    expect(devServer?.leftBehind).toBe(true);
    const [monitor] = deriveProjectRequests([request(1, stale)], [idleWith("monitor")], tree, NOW);
    expect(monitor?.leftBehind).toBe(true);
    const [subagent] = deriveProjectRequests(
      [request(1, stale)],
      [idleWith("subagent")],
      tree,
      NOW,
    );
    expect(subagent?.leftBehind).toBe(false);
  });

  it("drops settled requests, plain issues and requests from other projects", () => {
    const items = deriveProjectRequests(
      [
        request(1, { status: "done", closedAt: "2026-10-04T11:00:00.000Z" }),
        request(2, { isRequest: false }),
        request(3, {
          requestSource: { threadId: "x" as never, rootThreadId: "y" as never, messageId: "m" },
        }),
      ],
      [thread()],
      tree,
      NOW,
    );
    expect(items).toEqual([]);
  });
});

describe("requestKind", () => {
  it("reads the kind label and defaults to deliverable", () => {
    expect(requestKind(["ask", "ask:test"])).toBe("test");
    expect(requestKind(["ask"])).toBe("deliverable");
  });
});

describe("release stages", () => {
  const shipped = (number: number, release: string, test: string) =>
    request(number, {
      status: "needs-review",
      stage: "needs-test",
      milestone: { id: number, title: release },
      latestComment: {
        author: "agent",
        body: `Test: ${test}`,
        createdAt: "2026-10-04T11:00:00.000Z",
      },
    });

  it("keeps handed-over work out of Brad's groups and lists it for the next release", () => {
    const items = deriveProjectRequests(
      [
        request(1, { stage: "awaiting-release", status: "in-progress" }),
        shipped(2, "fork.24", "Open the Blocked list"),
      ],
      [thread()],
      tree,
      NOW,
      "root",
    );
    expect(items.map((item) => [item.issue.number, item.forYou, item.testStep])).toEqual([
      [1, null, null],
      [2, "test", "Open the Blocked list"],
    ]);
    const release = deriveRelease(items);
    expect(release.next.map((item) => item.issue.number)).toEqual([1]);
    expect(release.shipped).toEqual([{ release: "fork.24", items: [items[1]] }]);
  });

  it("does not flag waiting-for-release work as left behind", () => {
    const [item] = deriveProjectRequests(
      [request(1, { stage: "awaiting-release", updatedAt: "2026-09-01T00:00:00.000Z" })],
      [thread()],
      tree,
      NOW,
    );
    expect(item?.leftBehind).toBe(false);
  });

  it("maps each worker to the requests it serves, leaving out the orchestrator", () => {
    const items = deriveProjectRequests(
      [request(1, { stage: "in-progress", linkedThreadIds: ["root", "worker"] as never })],
      [thread(), thread({ id: "root" })],
      tree,
      NOW,
      "root",
    );
    const byWorker = requestsByWorker(items);
    expect(byWorker.get("worker")?.map((item) => item.issue.number)).toEqual([1]);
    expect(byWorker.has("root")).toBe(false);
  });
});
