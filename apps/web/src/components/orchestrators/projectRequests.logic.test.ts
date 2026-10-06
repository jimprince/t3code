import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import type { ProjectIssue } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  deriveCompleted,
  deriveMaintenance,
  deriveNeedsYou,
  deriveProjectRequests,
  latestProgressLine,
  nextReleaseRequests,
  requestKind,
  requestsByWorker,
  requestsOfSettledThreads,
  sentRequestStatus,
  taskKind,
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

  it("reads every task type and leaves untyped issues untyped", () => {
    expect(taskKind(["ask:bug"])).toBe("bug");
    expect(taskKind(["ask:feature"])).toBe("feature");
    expect(taskKind(["ASK:Maintenance"])).toBe("maintenance");
    expect(taskKind(["bug"])).toBeNull();
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
    expect(nextReleaseRequests(items).map((item) => item.issue.number)).toEqual([1]);
  });

  it("groups completed tasks by the release that shipped them, to-test first", () => {
    const issues = [
      shipped(2, "fork.24", "Open the Blocked list"),
      request(3, {
        status: "done",
        closedAt: "2026-10-03T00:00:00.000Z",
        milestone: { id: 24, title: "fork.24" },
      }),
      request(4, {
        status: "done",
        closedAt: "2026-10-02T00:00:00.000Z",
        milestone: { id: 9, title: "fork.9" },
        labels: ["ask:bug"],
        isRequest: false,
        requestSource: null,
      }),
      request(5, { status: "done", closedAt: "2026-10-03T00:00:00.000Z" }),
      // Closed elsewhere in the tracker, with no release and no link to this tree.
      request(6, {
        status: "done",
        closedAt: "2026-10-03T00:00:00.000Z",
        isRequest: false,
        requestSource: null,
      }),
      request(7, { status: "archived", closedAt: "2026-10-03T00:00:00.000Z" }),
    ];
    const items = deriveProjectRequests(issues, [thread()], tree, NOW, "root");
    const groups = deriveCompleted(issues, items, tree);
    expect(
      groups.map((group) => [
        group.release,
        group.items.map((task) => [task.issue.number, task.toTest !== null, task.kind]),
      ]),
    ).toEqual([
      [
        "fork.24",
        [
          [2, true, "question"],
          [3, false, "question"],
        ],
      ],
      ["fork.9", [[4, false, "bug"]]],
      [null, [[5, false, "question"]]],
    ]);
  });

  it("moves maintenance still with the agents out of Requests into Maintenance", () => {
    const issues = [
      request(1, { stage: "in-progress", labels: ["ask", "ask:maintenance"] }),
      request(2, { stage: "ready", status: "needs-review", labels: ["ask", "ask:maintenance"] }),
      request(3, { isRequest: false, requestSource: null, labels: ["ask:maintenance"] }),
      request(4, { isRequest: false, requestSource: null, labels: ["ask:bug"] }),
    ];
    const items = deriveProjectRequests(issues, [thread()], tree, NOW, "root");
    // The one needing Brad stays in Requests; the rest is upkeep.
    expect(deriveMaintenance(issues, items).map((task) => task.issue.number)).toEqual([1, 3]);
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

describe("latestProgressLine", () => {
  it("shows the first line without its prefix or markdown", () => {
    expect(latestProgressLine("Progress: **blocked** on the jaw pull force\nmore")).toBe(
      "blocked on the jaw pull force",
    );
    expect(latestProgressLine("<!-- marker -->\nTest: open the Blocked list")).toBe(
      "open the Blocked list",
    );
    expect(latestProgressLine(null)).toBeNull();
  });
});

describe("thread replied", () => {
  const replied = thread({
    latestRun: { status: "completed", completedAt: "2026-10-04T11:00:00.000Z" },
  });

  it("ignores replies once a request is in progress, and the orchestrator's replies to non-questions", () => {
    const items = deriveProjectRequests(
      [
        request(1, { stage: "in-progress", labels: ["ask", "ask:change"] }),
        request(2, {
          labels: ["ask", "ask:change"],
          requestSource: {
            threadId: "root" as never,
            rootThreadId: "root" as never,
            messageId: "m",
          },
        }),
        request(3, {
          requestSource: {
            threadId: "root" as never,
            rootThreadId: "root" as never,
            messageId: "m",
          },
        }),
      ],
      [replied, { ...replied, id: "root" } as never],
      tree,
      NOW,
      "root",
    );
    expect(items.map((item) => [item.issue.number, item.forYou])).toEqual([
      [1, null],
      [2, null],
      [3, "answers"],
    ]);
  });
});

describe("saved for later", () => {
  it("keeps parked ideas off the request list until they are started", () => {
    const parked = request(1, { labels: ["ask", "ask:change", "parked"] });
    const started = request(2, { labels: ["ask", "ask:change", "parked"], stage: "in-progress" });
    const items = deriveProjectRequests([parked, started], [thread()], tree, NOW, "root");
    expect(items.map((item) => item.issue.number)).toEqual([2]);
  });

  it("keeps parked issues out of Maintenance and Needs you", () => {
    const issues = [
      request(1, { isRequest: false, requestSource: null, labels: ["ask:maintenance", "parked"] }),
      request(2, {
        isRequest: false,
        requestSource: null,
        status: "needs-review",
        labels: ["parked"],
      }),
    ];
    expect(deriveMaintenance(issues, [])).toEqual([]);
    expect(deriveNeedsYou(issues, [])).toEqual([]);
  });
});

describe("needs you", () => {
  it("is Brad's request groups plus any issue marked for his review or test", () => {
    const issues = [
      request(1, { status: "needs-review", stage: "ready" }),
      request(2, { stage: "in-progress" }),
      request(3, { isRequest: false, requestSource: null, status: "needs-review" }),
      request(4, { isRequest: false, requestSource: null, labels: ["needs-test"] }),
      request(5, { isRequest: false, requestSource: null }),
    ];
    const items = deriveProjectRequests(issues, [thread()], tree, NOW, "root");
    expect(
      deriveNeedsYou(issues, items).map((item) => [item.issue.number, item.group, !!item.request]),
    ).toEqual([
      [1, "answers", true],
      [3, "review", false],
      [4, "test", false],
    ]);
  });

  it("gathers open requests of threads Brad already settled", () => {
    const settled = thread({ settledAt: "2026-10-04T11:00:00.000Z" });
    const items = deriveProjectRequests(
      [request(1, { stage: "in-progress" }), request(2, { stage: "in-progress" })],
      [settled],
      tree,
      NOW,
      "root",
    );
    const groups = requestsOfSettledThreads(items);
    expect(groups.map((group) => group.requests.map((item) => item.issue.number))).toEqual([
      [1, 2],
    ]);
    expect(
      requestsOfSettledThreads(deriveProjectRequests([request(3)], [thread()], tree, NOW)),
    ).toEqual([]);
  });
});

describe("sent from the request box", () => {
  const filed = (number: number, messageId: string) =>
    request(number, {
      requestSource: { threadId: "root" as never, rootThreadId: "root" as never, messageId },
    });

  it("links every request the ledger filed for the message", () => {
    const status = sentRequestStatus("m1", [filed(4, "m1"), filed(5, "m2"), filed(6, "m1")], []);
    expect(status.state === "tracked" && status.issues.map((issue) => issue.number)).toEqual([
      4, 6,
    ]);
  });

  it("says pending filing while Gitea is down, and nothing more before filing", () => {
    expect(sentRequestStatus("m1", [], [{ messageId: "m1" }])).toEqual({ state: "pending" });
    expect(sentRequestStatus("m1", [filed(5, "m2")], [])).toEqual({ state: "filing" });
  });
});
