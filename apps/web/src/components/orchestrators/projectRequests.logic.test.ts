import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import type { ProjectIssue } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  deriveCompleted,
  deriveMaintenance,
  deriveNeedsYou,
  deriveProjectRequests,
  isBug,
  isMaintenance,
  latestProgressLine,
  needsYouDecision,
  parseDecisionComment,
  nextReleaseRequests,
  requestKind,
  requestsByWorker,
  requestsOfSettledThreads,
  answerSentences,
  countStatuses,
  formatStatusCounts,
  taskStatuses,
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

const answer = {
  text: "Its actions: service calls or scripts. Triggers start it, conditions gate it.",
  askedAt: "2026-10-04T10:00:00.000Z",
  answeredAt: "2026-10-04T10:05:00.000Z",
};

describe("deriveProjectRequests", () => {
  it("puts a request the agent marked ready in Brad's group for its kind", () => {
    const [question, plan] = deriveProjectRequests(
      [
        request(1, { status: "needs-review", stage: "ready" }),
        request(2, { status: "needs-review", stage: "ready", labels: ["ask", "ask:epic"] }),
      ],
      [thread()],
      tree,
      NOW,
    );
    expect(question?.forYou).toBe("answers");
    expect(plan?.forYou).toBe("approve");
  });

  it("treats the thread's answer to the request as ready even before the agent marks it", () => {
    const [item] = deriveProjectRequests(
      [request(1, { labels: ["ask", "ask:task"], answer })],
      [thread()],
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
  it("reads the current type labels and defaults to task", () => {
    expect(requestKind(["ask", "ask:epic"])).toBe("epic");
    expect(requestKind(["ask", "ask:question"])).toBe("question");
    expect(requestKind(["ask"])).toBe("task");
  });

  it("reads earlier labels as their successor and leaves untyped issues untyped", () => {
    expect(taskKind(["ask:plan"])).toBe("epic");
    expect(taskKind(["ask:bug"])).toBe("task");
    expect(taskKind(["ask:feature"])).toBe("task");
    expect(taskKind(["ASK:Maintenance"])).toBe("task");
    expect(taskKind(["ask:question"])).toBe("question");
    expect(taskKind(["bug"])).toBeNull();
  });

  it("lets a current label win over earlier ones", () => {
    expect(taskKind(["ask:plan", "ask:task"])).toBe("task");
    expect(taskKind(["ask:feature", "ask:epic"])).toBe("epic");
    expect(taskKind(["ask:bug", "ask:question"])).toBe("question");
  });

  it("reads the bug tag from the bug label, or from ask:bug when no current label exists", () => {
    expect(isBug(["ask", "ask:task", "bug"])).toBe(true);
    expect(isBug(["ask:bug"])).toBe(true);
    expect(isBug(["ask:bug", "ask:task"])).toBe(false);
    expect(isBug(["ask:feature"])).toBe(false);
  });

  it("treats only a task with the earlier maintenance label as maintenance", () => {
    expect(isMaintenance(["ask", "ask:maintenance"])).toBe(true);
    expect(isMaintenance(["ask", "ask:maintenance", "ask:task"])).toBe(true);
    expect(isMaintenance(["ask", "ask:maintenance", "ask:question"])).toBe(false);
    expect(isMaintenance(["ask", "ask:task"])).toBe(false);
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
      ["fork.9", [[4, false, "task"]]],
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

  it("keeps paths, hashes and issue numbers out of the row", () => {
    expect(
      latestProgressLine(
        "Progress: Fix built, unpublished: patch fork-project-skew-gate (0bd6f7eab) in ~/maintenance-work/task-panel-skew; ready for the fork.30 batch",
      ),
    ).toBe("Fix built, unpublished: patch fork-project-skew-gate; ready for the fork.30 batch");
    expect(latestProgressLine("Progress: merged the fix (#139), faded 1234567 deadbeef")).toBe(
      "merged the fix, faded deadbeef",
    );
  });

  it("shows no curator notes, follow-ups or a bare start", () => {
    expect(
      latestProgressLine("Curator: typed as a bug task. Old labels kept as history."),
    ).toBeNull();
    expect(latestProgressLine("Follow-up from Brad in **T3 Orchestrator**:\nGo ahead")).toBeNull();
    expect(latestProgressLine("Progress: started")).toBeNull();
  });
});

describe("thread replied", () => {
  const fromRoot = {
    threadId: "root" as never,
    rootThreadId: "root" as never,
    messageId: "m",
  };

  it("ignores answers once a request is in progress, and the orchestrator's replies to non-questions", () => {
    const items = deriveProjectRequests(
      [
        request(1, { stage: "in-progress", labels: ["ask", "ask:change"], answer }),
        request(2, { labels: ["ask", "ask:change"], requestSource: fromRoot, answer }),
        request(3, { requestSource: fromRoot, answer }),
      ],
      [thread(), thread({ id: "root" })],
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

  // Regression (fork.26 flicker): the page swapped a question between Needs you and
  // the Requests list every time the orchestrator started or finished another turn.
  it("keeps each request in one group whatever its thread is doing", () => {
    const issues = [
      request(1, { requestSource: fromRoot, answer }),
      request(2, { requestSource: fromRoot }),
    ];
    const states = [
      thread({ id: "root", runtime: { status: "running" }, latestRun: { status: "running" } }),
      thread({
        id: "root",
        runtime: { status: "idle" },
        latestRun: { status: "completed", completedAt: "2026-10-04T11:30:00.000Z" },
      }),
      thread({ id: "root", pendingBackgroundTasks: [{}] }),
    ];
    const groups = states.map((root) =>
      deriveProjectRequests(issues, [root], tree, NOW, "root").map((item) => item.forYou),
    );
    expect(groups).toEqual([
      ["answers", null],
      ["answers", null],
      ["answers", null],
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
    expect(groups[0]?.title).toBe(settled.title);
    // One request: its own title, not the intake thread's raw "Intake: Hey..." name.
    const single = requestsOfSettledThreads(
      deriveProjectRequests([request(1, { stage: "in-progress" })], [settled], tree, NOW, "root"),
    );
    expect(single[0]?.title).toBe("Request 1");
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

describe("answer sentences", () => {
  it("keeps up to three whole sentences without markdown and never adds an ellipsis", () => {
    expect(
      answerSentences("**Yes.** It runs `nightly`. Then it posts.\n\nMore detail here. And more."),
    ).toBe("Yes. It runs nightly. Then it posts.");
    expect(answerSentences("Short answer without a period")).toBe("Short answer without a period");
  });
});

describe("task status", () => {
  it("is Complete, For review, Active or Pending from the same sources everywhere", () => {
    const issues = [
      request(1, { status: "done", closedAt: "2026-10-04T11:00:00.000Z" }),
      request(2, { status: "needs-review", stage: "ready" }),
      request(3, { stage: "in-progress", status: "in-progress" }),
      request(4, { linkedThreadIds: ["worker"] as never }),
      request(5, { linkedThreadIds: ["root"] as never }),
    ];
    const threads = [
      thread({ id: "worker", runtime: { status: "running" } }),
      thread({ id: "root", runtime: { status: "running" } }),
    ];
    const requests = deriveProjectRequests(issues, threads, tree, NOW, "root");
    const statuses = taskStatuses(issues, deriveNeedsYou(issues, requests), threads, "root");
    expect([...statuses.values()]).toEqual([
      "complete",
      "for-review",
      "active",
      // A working worker makes its task Active; the busy orchestrator alone does not.
      "active",
      "pending",
    ]);
  });

  it("counts a version's progress, closed tasks included", () => {
    const counts = countStatuses(["active", "pending", "pending", "for-review"], 12);
    expect(formatStatusCounts(counts)).toBe(
      "16 · 12 complete · 1 active · 1 for review · 2 pending",
    );
  });
});

describe("parseDecisionComment", () => {
  it("lists the options a comment names and keeps the rest as the summary", () => {
    const parsed = parseDecisionComment(
      [
        "The V2 port can land in one go or in steps. Pick how.",
        "Option A: port everything in one patch",
        "**Option B:** port in two steps",
        "Recommendation: Option B, it keeps each patch reviewable.",
      ].join("\n"),
    );
    expect(parsed.options).toEqual([
      { label: "Option A", text: "port everything in one patch" },
      { label: "Option B", text: "port in two steps" },
    ]);
    expect(parsed.recommendation).toBe("Option B, it keeps each patch reviewable.");
    expect(parsed.summary).toBe("The V2 port can land in one go or in steps. Pick how.");
  });

  it("reads lettered lines too", () => {
    const parsed = parseDecisionComment("Which database?\nA) SQLite\n(B) Postgres\nC: neither");
    expect(parsed.options.map((option) => option.label)).toEqual([
      "Option A",
      "Option B",
      "Option C",
    ]);
    expect(parsed.options[1]?.text).toBe("Postgres");
  });

  it("does not take a lone lettered line or a numbered list for choices", () => {
    expect(parseDecisionComment("Steps:\nA: first thing").options).toEqual([]);
    expect(parseDecisionComment("1) one\n2) two").options).toEqual([]);
    expect(parseDecisionComment("A) once\nA) again").options).toEqual([]);
  });

  it("finds the recommendation without options", () => {
    const parsed = parseDecisionComment("Ready to start.\nI recommend approving it now.");
    expect(parsed.recommendation).toBe("approving it now.");
    expect(parsed.summary).toBe("Ready to start.");
  });
});

describe("needsYouDecision", () => {
  const needsYou = (issue: ProjectIssue) =>
    deriveNeedsYou([issue], deriveProjectRequests([issue], [thread()], tree, NOW))[0]!;
  const ready = { status: "needs-review" as const, stage: "ready" as const };

  it("asks for approval of a plan or epic marked ready", () => {
    for (const label of ["ask:plan", "ask:epic"]) {
      const decision = needsYouDecision(
        needsYou(
          request(1, {
            ...ready,
            labels: ["ask", label],
            latestComment: {
              author: "worker",
              body: "Progress: M1 plan is ready. Review the milestones.",
              createdAt: "2026-10-04T11:00:00.000Z",
            },
          }),
        ),
      );
      expect(decision?.options).toEqual([]);
      expect(decision?.summary).toBe("M1 plan is ready. Review the milestones.");
    }
  });

  it("asks to choose when the ready comment lists options", () => {
    const decision = needsYouDecision(
      needsYou(
        request(2, {
          ...ready,
          labels: ["ask", "ask:deliverable"],
          latestComment: {
            author: "worker",
            body: "Option A: keep it\nOption B: remove it",
            createdAt: "2026-10-04T11:00:00.000Z",
          },
        }),
      ),
    );
    expect(decision?.options.map((option) => option.label)).toEqual(["Option A", "Option B"]);
  });

  it("leaves answers, shipped work and plain finished work as they are", () => {
    expect(needsYouDecision(needsYou(request(3, { ...ready, answer })))).toBeNull();
    expect(
      needsYouDecision(needsYou(request(4, { ...ready, labels: ["ask", "ask:deliverable"] }))),
    ).toBeNull();
    expect(
      needsYouDecision(
        needsYou(
          request(5, { status: "needs-review", stage: "needs-test", labels: ["ask", "ask:plan"] }),
        ),
      ),
    ).toBeNull();
  });

  it("does not ask for a plan the thread merely answered", () => {
    expect(
      needsYouDecision(needsYou(request(6, { labels: ["ask", "ask:plan"], answer }))),
    ).toBeNull();
  });

  it("covers an epic issue the tracker marked for review", () => {
    const issue = request(7, {
      isRequest: false,
      requestSource: null,
      status: "needs-review",
      labels: ["ask:epic"],
      linkedThreadIds: ["worker" as never],
    });
    expect(needsYouDecision(needsYou(issue))).toEqual({
      summary: "",
      recommendation: null,
      options: [],
    });
  });
});
