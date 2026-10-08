import type { ProjectIssue, ProjectPendingAsk, ThreadPullRequestLink } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  asksWithFallbacks,
  buildDecisionFeed,
  clampMarkdownBlocks,
  decisionContextMarkdown,
  feedItemsOf,
  feedCardOwner,
  reviewPullRequest,
  splitMarkdownBlocks,
  withoutDeadlineLine,
} from "./decisionFeed.ts";

const NOW = Date.parse("2026-10-08T12:00:00.000Z");

const issue = (number: number, extra: Partial<ProjectIssue> = {}): ProjectIssue =>
  ({
    host: "git.home",
    repository: "brad/repo",
    number,
    title: `Issue ${number}`,
    url: `http://git.home/brad/repo/issues/${number}`,
    status: "pending",
    labels: [],
    isRequest: false,
    requestSource: null,
    assignees: [],
    comments: 0,
    createdAt: `2026-10-0${number}T00:00:00.000Z`,
    updatedAt: "2026-10-08T00:00:00.000Z",
    closedAt: null,
    linkedThreadIds: [],
    ...extra,
  }) as ProjectIssue;

const decision = (number: number, extra: Partial<ProjectIssue> = {}) =>
  issue(number, {
    decision: { context: "Which?", waiting: "w", options: [] },
    owner: {
      threadId: "w" as never,
      title: "End Effector Orchestrator",
      projectTitle: "Printcell",
    },
    ...extra,
  });

const ask = (id: string, at: string, project = "Home Assistant"): ProjectPendingAsk => ({
  kind: "question",
  threadId: `t-${id}` as never,
  threadTitle: `Thread ${id}`,
  projectTitle: project,
  requestId: id as never,
  createdAt: at,
  canRespond: true,
  questions: [],
  messageResponse: false,
});

const feed = (input: Partial<Parameters<typeof buildDecisionFeed>[0]> = {}) =>
  buildDecisionFeed({
    asks: [],
    plans: [],
    decisions: [],
    items: [],
    now: NOW,
    project: null,
    ...input,
  });

describe("buildDecisionFeed", () => {
  it("leads with stalled threads, then everything else oldest first", () => {
    const result = feed({
      asks: [ask("late", "2026-10-07T10:00:00.000Z"), ask("early", "2026-10-06T10:00:00.000Z")],
      plans: [
        {
          threadId: "p1",
          title: "Plan thread",
          projectTitle: "Printcell",
          since: "2026-10-07T00:00:00.000Z",
        },
      ],
      decisions: [decision(3), decision(1)],
      items: [{ issue: issue(2), group: "review" }],
    });
    expect(result.cards.map((card) => card.key)).toEqual([
      "t-early:early",
      "p1:plan",
      "t-late:late",
      "brad/repo#1",
      "brad/repo#2",
      "brad/repo#3",
    ]);
    expect(result.cards.map((card) => card.kind)).toEqual([
      "question",
      "plan",
      "question",
      "decision",
      "review",
      "decision",
    ]);
  });

  it("shows an issue that is both a decision and an item once, as the decision", () => {
    const both = decision(4);
    const result = feed({ decisions: [both], items: [{ issue: both, group: "answers" }] });
    expect(result.cards).toHaveLength(1);
    expect(result.cards[0]?.kind).toBe("decision");
  });

  it("keeps every kind of item a card, with approve items as decisions to approve", () => {
    const result = feed({
      items: [
        { issue: issue(1), group: "answers" },
        { issue: issue(2), group: "approve" },
        { issue: issue(3), group: "review" },
        { issue: issue(4), group: "test", testStep: "Press the button" },
      ],
    });
    expect(result.cards.map((card) => card.kind)).toEqual(["answer", "decision", "review", "test"]);
    const approve = result.cards[1];
    expect(approve?.kind === "decision" && approve.approve).toBe(true);
    const test = result.cards[3];
    expect(test?.kind === "test" && test.testStep).toBe("Press the button");
  });

  it("hides a deferred card until it returns, then shows it again", () => {
    const deferred = decision(1, {
      deferral: { until: "2026-10-09T12:00:00.000Z", movedToEndAt: null },
    });
    const hidden = feed({ decisions: [deferred, decision(2)] });
    expect(hidden.cards.map((card) => card.key)).toEqual(["brad/repo#2"]);
    expect(hidden.later.map((entry) => [entry.card.key, entry.returnsAt])).toEqual([
      ["brad/repo#1", "2026-10-09T12:00:00.000Z"],
    ]);
    expect(hidden.total).toBe(1);

    const back = feed({ decisions: [deferred], now: Date.parse("2026-10-09T12:00:01.000Z") });
    expect(back.cards.map((card) => card.key)).toEqual(["brad/repo#1"]);
    expect(back.later).toEqual([]);
  });

  it("brings a card back a day before its deadline whatever time was chosen", () => {
    const deferred = decision(1, {
      decision: { context: "Which?", waiting: "w", options: [], deadline: "2026-10-09" },
      deferral: { until: "2026-10-20T00:00:00.000Z", movedToEndAt: null },
    });
    const early = feed({ decisions: [deferred], now: Date.parse("2026-10-07T12:00:00.000Z") });
    expect(early.later[0]).toMatchObject({
      returnsAt: "2026-10-08T00:00:00.000Z",
      forDeadline: true,
    });
    const due = feed({ decisions: [deferred] });
    expect(due.cards).toHaveLength(1);
  });

  it("puts a card moved to the end behind the others without hiding it", () => {
    const moved = decision(1, {
      deferral: { until: null, movedToEndAt: "2026-10-08T11:00:00.000Z" },
    });
    const result = feed({ decisions: [moved, decision(2), decision(3)] });
    expect(result.cards.map((card) => card.key)).toEqual([
      "brad/repo#2",
      "brad/repo#3",
      "brad/repo#1",
    ]);
  });

  it("counts cards per project, and filtering keeps every chip", () => {
    const result = feed({
      asks: [ask("a", "2026-10-06T00:00:00.000Z", "Home Assistant")],
      decisions: [decision(1), decision(2)],
      project: "Printcell",
    });
    expect(result.chips).toEqual([
      { project: "Printcell", count: 2 },
      { project: "Home Assistant", count: 1 },
    ]);
    expect(result.cards.map((card) => card.key)).toEqual(["brad/repo#1", "brad/repo#2"]);
    expect(result.total).toBe(3);
  });
});

describe("feedCardOwner", () => {
  it("names the waiting thread and its project, and who the orchestrator stands in for", () => {
    const [question, standIn] = feed({
      asks: [ask("a", "2026-10-06T00:00:00.000Z")],
      items: [
        {
          issue: issue(5, {
            owner: {
              threadId: "root" as never,
              title: "T3 Orchestrator",
              projectTitle: "t3code",
              previousTitle: "Opus worker 989fff91",
            },
          }),
          group: "review",
        },
      ],
    }).cards;
    expect(feedCardOwner(question!)).toEqual({
      name: "Thread a",
      project: "Home Assistant",
      standingInFor: null,
    });
    expect(feedCardOwner(standIn!)).toEqual({
      name: "T3 Orchestrator",
      project: "t3code",
      standingInFor: "Opus worker 989fff91",
    });
  });
});

describe("reviewPullRequest", () => {
  const link = (number: number, linkedAt: string, extra: Partial<ThreadPullRequestLink> = {}) =>
    ({
      host: "git.home",
      repository: "brad/repo",
      number,
      url: `http://git.home/brad/repo/pulls/${number}`,
      source: "manual",
      linkedAt,
      snapshot: null,
      stack: null,
      ...extra,
    }) as ThreadPullRequestLink;
  const snapshot = (state: "open" | "merged", extra: object = {}) =>
    ({
      state,
      additions: 541,
      deletions: 3,
      changedFiles: 4,
      mergeability: "mergeable",
      ...extra,
    }) as never;

  it("takes the newest open pull request of the threads that serve the issue", () => {
    const found = reviewPullRequest({ repository: "brad/repo", linkedThreadIds: ["w1" as never] }, [
      {
        id: "w1",
        pullRequests: [
          link(10, "2026-10-01T00:00:00.000Z", { snapshot: snapshot("merged") }),
          link(11, "2026-10-02T00:00:00.000Z", {
            snapshot: snapshot("open", { mergeability: "conflicting" }),
            watch: { headSha: "abc123" } as never,
          }),
          link(12, "2026-10-03T00:00:00.000Z", { repository: "other/repo" }),
        ],
      },
      { id: "unrelated", pullRequests: [link(99, "2026-10-09T00:00:00.000Z")] },
    ]);
    expect(found).toEqual({
      number: 11,
      url: "http://git.home/brad/repo/pulls/11",
      additions: 541,
      deletions: 3,
      changedFiles: 4,
      conflicting: true,
      draft: false,
      headSha: "abc123",
    });
  });

  it("finds none when every linked pull request is merged", () => {
    expect(
      reviewPullRequest({ repository: "brad/repo", linkedThreadIds: ["w1" as never] }, [
        {
          id: "w1",
          pullRequests: [link(10, "2026-10-01T00:00:00.000Z", { snapshot: snapshot("merged") })],
        },
      ]),
    ).toBeNull();
  });
});

describe("context helpers", () => {
  it("drops only the deadline line", () => {
    expect(withoutDeadlineLine("Lead.\n\ndeadline: Oct 8\n\n- a\n- b")).toBe("Lead.\n\n- a\n- b");
    expect(withoutDeadlineLine("The deadline: matters here")).toBe("The deadline: matters here");
  });

  it("turns the editor's <img> tags into Markdown images and drops comments and the deadline", () => {
    expect(
      decisionContextMarkdown(
        'Look:\n<img src="/attachments/abc" alt="mock A" width="300">\n<!-- note -->\ndeadline: Oct 8',
      ),
    ).toBe("Look:\n![mock A](/attachments/abc)");
    expect(decisionContextMarkdown('<img alt="no source">')).toBe("");
  });

  it("cuts Markdown into whole blocks: paragraphs, a loose list, a table, a fence", () => {
    const blocks = splitMarkdownBlocks(
      [
        "Lead sentence.",
        "",
        "- one",
        "",
        "- two",
        "- three",
        "",
        "| set | mass |",
        "| --- | --- |",
        "| magnet | 69 g |",
        "",
        "```",
        "a",
        "",
        "b",
        "```",
        "",
        "Last.",
      ].join("\n"),
    );
    expect(blocks).toEqual([
      "Lead sentence.",
      "- one\n\n- two\n- three",
      "| set | mass |\n| --- | --- |\n| magnet | 69 g |",
      "```\na\n\nb\n```",
      "Last.",
    ]);
  });

  it("clamps by blocks and says how many More adds", () => {
    expect(clampMarkdownBlocks(["a", "b", "c", "d"])).toEqual({ shown: ["a", "b"], hidden: 2 });
    expect(clampMarkdownBlocks(["a"])).toEqual({ shown: ["a"], hidden: 0 });
  });
});

describe("asksWithFallbacks", () => {
  const waiting = [
    {
      kind: "input" as const,
      threadId: "t-a",
      title: "Asker",
      projectTitle: "P",
      updatedAt: "2026-10-08T00:00:00.000Z",
    },
    {
      kind: "approval" as const,
      threadId: "t-b",
      title: "Approver",
      projectTitle: "P",
      updatedAt: "2026-10-08T01:00:00.000Z",
    },
  ];

  it("gives a bare card to every waiting thread the server returned no text for", () => {
    const returned = [ask("a", "2026-10-06T00:00:00.000Z")];
    const asks = asksWithFallbacks({
      returned: [{ ...returned[0]!, threadId: "t-a" as never }],
      waiting,
      loading: false,
    });
    expect(asks.map((entry) => [entry.kind, entry.threadId, entry.canRespond])).toEqual([
      ["question", "t-a", true],
      ["approval", "t-b", false],
    ]);
  });

  it("drops an ask whose thread no longer waits", () => {
    const stale = { ...ask("old", "2026-10-06T00:00:00.000Z"), threadId: "t-gone" as never };
    const asks = asksWithFallbacks({ returned: [stale], waiting: [], loading: false });
    expect(asks).toEqual([]);
  });

  it("adds nothing while the first read is still loading", () => {
    expect(asksWithFallbacks({ returned: [], waiting, loading: true })).toEqual([]);
  });

  it("covers every waiting thread when the read failed", () => {
    const asks = asksWithFallbacks({ returned: [], waiting, loading: false });
    expect(asks.map((entry) => entry.kind)).toEqual(["question", "approval"]);
    const shown = feed({ asks });
    expect(shown.cards.map((card) => card.kind)).toEqual(["question", "approval"]);
  });
});

describe("feedItemsOf", () => {
  const owned = (number: number, extra: Partial<ProjectIssue> = {}) =>
    issue(number, {
      owner: { threadId: "w" as never, title: "W", projectTitle: "P" },
      ...extra,
    });

  it("groups the issues the server marked for Brad", () => {
    const items = feedItemsOf([
      owned(1, {
        labels: ["needs-test"],
        latestComment: { author: "a", body: "Test: press the button\nthen wait", createdAt: "x" },
      }),
      owned(2, { status: "needs-review" }),
      owned(3, { status: "needs-review", labels: ["ask:epic"] }),
      owned(4, { stage: "requested", answer: { text: "Yes.", askedAt: "x", answeredAt: "y" } }),
    ]);
    expect(items.map((item) => [item.issue.number, item.group, item.testStep ?? null])).toEqual([
      [1, "test", "press the button"],
      [2, "review", null],
      [3, "approve", null],
      [4, "answers", null],
    ]);
  });

  it("counts a reply as an answer only while nobody picked the request up", () => {
    const reply = { text: "Yes.", askedAt: "x", answeredAt: "y" };
    const source = (threadId: string) =>
      ({ threadId, rootThreadId: "root", messageId: "m" }) as never;
    const items = feedItemsOf([
      owned(1, { stage: "in-progress", answer: reply }),
      owned(2, { stage: "requested", answer: reply, requestSource: source("root") }),
      owned(3, {
        stage: "requested",
        answer: reply,
        requestSource: source("root"),
        labels: ["ask:question"],
      }),
      owned(4, { stage: "requested", answer: reply, requestSource: source("worker") }),
      owned(5, { stage: "requested", answer: reply, labels: ["parked"] }),
    ]);
    expect(items.map((item) => item.issue.number)).toEqual([3, 4]);
  });

  it("skips decisions, closed issues and issues nobody marked for Brad", () => {
    expect(
      feedItemsOf([
        owned(1, { decision: { context: "", waiting: "w", options: [] }, status: "needs-review" }),
        owned(2, { status: "needs-review", closedAt: "2026-10-08T00:00:00.000Z" }),
        issue(3, { status: "needs-review" }),
        owned(4),
      ]),
    ).toEqual([]);
  });
});
