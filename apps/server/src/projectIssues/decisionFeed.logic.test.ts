import { describe, expect, it } from "vite-plus/test";
import { RuntimeRequestId, ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import {
  applyDeferral,
  mergeBlocker,
  ownerOfIssue,
  parseDecisionDeadline,
  parseDeferral,
  pendingAsksOfThread,
  planSendBack,
  pullRequestsClosing,
} from "./decisionFeed.logic.ts";
import { parseDecisionIssue } from "./decisions.logic.ts";

const FILED = "2026-10-06T10:00:00.000Z";

describe("parseDecisionDeadline", () => {
  it("reads an ISO date and an instant", () => {
    expect(parseDecisionDeadline("Pick one.\ndeadline: 2026-10-08", FILED)).toBe("2026-10-08");
    expect(parseDecisionDeadline("Deadline: 2026-10-08 17:30", FILED)).toBe(
      "2026-10-08T17:30:00.000Z",
    );
  });

  it("reads a month name, taking the year from when the issue was filed", () => {
    expect(parseDecisionDeadline("- **deadline:** Oct 8", FILED)).toBe("2026-10-08");
    expect(parseDecisionDeadline("deadline: October 15th, 2027", FILED)).toBe("2027-10-15");
  });

  it("rolls a month already behind the filing date into next year", () => {
    expect(parseDecisionDeadline("deadline: Jan 5", "2026-12-20T00:00:00.000Z")).toBe("2027-01-05");
  });

  it("reads an instant with an offset as the same moment in UTC", () => {
    expect(parseDecisionDeadline("deadline: 2026-10-08T17:00+02:00", FILED)).toBe(
      "2026-10-08T15:00:00.000Z",
    );
    expect(parseDecisionDeadline("deadline: 2026-10-08 17:00 -0600", FILED)).toBe(
      "2026-10-08T23:00:00.000Z",
    );
  });

  it("does not read a month and year as a month and day", () => {
    expect(parseDecisionDeadline("deadline: June 2026", FILED)).toBeNull();
    expect(parseDecisionDeadline("deadline: end of March 2027", FILED)).toBeNull();
    expect(parseDecisionDeadline("deadline: 2026-02-31", FILED)).toBeNull();
  });

  it("finds nothing without a deadline line or a real date", () => {
    expect(parseDecisionDeadline("Renews on Oct 8, no hurry.", FILED)).toBeNull();
    expect(parseDecisionDeadline("deadline: soon", FILED)).toBeNull();
    expect(parseDecisionDeadline("deadline: Feb 31", FILED)).toBeNull();
  });
});

describe("Later in the issue body", () => {
  const body = "Which set?\n\n```decision\noptions:\n- A\n- B\n```";

  it("round-trips through the body without changing the decision", () => {
    const deferred = applyDeferral(body, { mode: "until", until: "2026-10-09T15:00:00.000Z" });
    expect(parseDeferral(deferred.body)).toEqual({
      until: "2026-10-09T15:00:00.000Z",
      movedToEndAt: null,
    });
    expect(parseDecisionIssue(deferred.body)).toEqual(parseDecisionIssue(body));
  });

  it("keeps the other half when one changes, and replaces the marker rather than stacking", () => {
    const first = applyDeferral(body, { mode: "until", until: "2026-10-09T15:00:00.000Z" });
    const second = applyDeferral(first.body, { mode: "end", now: "2026-10-08T05:00:00.000Z" });
    const third = applyDeferral(second.body, { mode: "until", until: "2026-10-10T00:00:00.000Z" });
    expect(parseDeferral(third.body)).toEqual({
      until: "2026-10-10T00:00:00.000Z",
      movedToEndAt: "2026-10-08T05:00:00.000Z",
    });
    expect(third.body.match(/t3-deferral/g)).toHaveLength(1);
  });

  it("clear restores the original body", () => {
    const deferred = applyDeferral(body, { mode: "end", now: "2026-10-08T05:00:00.000Z" });
    expect(applyDeferral(deferred.body, { mode: "clear" })).toEqual({ body, deferral: null });
  });

  it("ignores an unreadable marker instead of failing the list", () => {
    expect(parseDeferral("x\n<!-- t3-deferral {nope} -->")).toBeNull();
    expect(parseDeferral('<!-- t3-deferral {"until":"not a date"} -->')).toBeNull();
  });
});

describe("ownerOfIssue", () => {
  const thread = (id: string, title: string, archivedAt: string | null = null) => ({
    id,
    title,
    projectId: "p1",
    updatedAt: FILED,
    archivedAt,
    parentThreadId: id === "root" ? null : "root",
  });
  const projects = [{ id: "p1", title: "printcell" }];

  it("sends a decision to the thread it waits on, with that thread's project", () => {
    const owner = ownerOfIssue({
      waiting: "w1",
      linkedThreadIds: [],
      rootThreadId: "root",
      threads: [thread("root", "Orchestrator"), thread("w1", "End Effector Orchestrator")],
      projects,
    });
    expect(owner).toEqual({
      threadId: "w1",
      title: "End Effector Orchestrator",
      projectTitle: "printcell",
    });
  });

  it("falls back to the orchestrator when the waiting thread cannot be found", () => {
    const owner = ownerOfIssue({
      waiting: "someone-long-gone",
      linkedThreadIds: [],
      rootThreadId: "root",
      threads: [thread("root", "Orchestrator")],
      projects,
    });
    expect(owner?.threadId).toBe("root");
    expect(owner?.previousTitle).toBeUndefined();
  });

  it("names an archived worker when the orchestrator stands in", () => {
    const owner = ownerOfIssue({
      waiting: null,
      linkedThreadIds: ["w9"],
      rootThreadId: "root",
      threads: [thread("root", "Orchestrator"), thread("w9", "Opus worker 989fff91", FILED)],
      projects,
    });
    expect(owner).toMatchObject({ threadId: "root", previousTitle: "Opus worker 989fff91" });
  });
});

describe("pullRequestsClosing", () => {
  const prs = [
    { number: 1, title: "fix: a", body: "Closes #133" },
    { number: 2, title: "fix: b", body: "Fixes brad/repo#133, resolves #5" },
    { number: 3, title: "Resolves #1330", body: "" },
    { number: 4, title: "see #133", body: "related to #133" },
    { number: 5, title: "fix: other", body: "Fixes other/repo#133" },
    { number: 6, title: "fix: dotted", body: "closes BRAD/repo#133" },
  ];

  it("does not take another repository's issue of the same number", () => {
    expect(pullRequestsClosing(prs, 133, "brad/repo").some((pr) => pr.number === 5)).toBe(false);
    expect(pullRequestsClosing(prs, 133, "other/repo").map((pr) => pr.number)).toEqual([1, 5]);
  });

  it("matches closing keywords for exactly that number", () => {
    expect(pullRequestsClosing(prs, 133, "brad/repo").map((pr) => pr.number)).toEqual([1, 2, 6]);
    expect(pullRequestsClosing(prs, 5, "brad/repo").map((pr) => pr.number)).toEqual([2]);
    expect(pullRequestsClosing(prs, 1330, "brad/repo").map((pr) => pr.number)).toEqual([3]);
  });
});

describe("mergeBlocker", () => {
  it("allows only an open pull request the host says is mergeable", () => {
    expect(mergeBlocker({ number: 1, state: "open", mergeable: true })).toBeNull();
    expect(mergeBlocker({ number: 1, state: "open", mergeable: null })).toContain("Try again");
    expect(mergeBlocker({ number: 1, state: "open" })).toContain("Try again");
  });

  it("names why a pull request cannot merge", () => {
    expect(mergeBlocker({ number: 195, state: "open", mergeable: false, base: "main" })).toBe(
      "PR 195 is not mergeable into main: it conflicts, or Gitea is still checking it. Try again in a moment, or send it back to be rebased.",
    );
    expect(mergeBlocker({ number: 2, state: "open", draft: true, mergeable: true })).toBe(
      "PR 2 is a draft.",
    );
    expect(mergeBlocker({ number: 3, state: "closed" })).toBe("PR 3 is closed.");
    expect(mergeBlocker({ number: 4, state: "closed", merged: true })).toBe(
      "PR 4 is already merged.",
    );
  });
});

describe("planSendBack", () => {
  it("quotes the note on the issue and in the message", () => {
    const plan = planSendBack({
      note: "  Rebase onto main.  ",
      title: "Stale verdict",
      reference: "brad/repo#133",
      url: "http://git/brad/repo/issues/133",
    });
    expect(plan?.comment).toBe("Brad sent this back:\n\nRebase onto main.");
    expect(plan?.message).toContain('brad/repo#133 "Stale verdict"');
  });

  it("has nothing to send without a note", () => {
    expect(planSendBack({ note: " ", title: "t", reference: "r#1", url: "u" })).toBeNull();
  });
});

describe("pendingAsksOfThread", () => {
  const request = (id: string, kind: string, at: string) =>
    ({
      id: RuntimeRequestId.make(id),
      kind,
      status: "pending",
      createdAt: DateTime.makeUnsafe(at),
      responseCapability: { type: "live" },
    }) as never;

  it("pairs each pending request with its text, oldest first, and skips resolved ones", () => {
    const asks = pendingAsksOfThread(
      { id: ThreadId.make("t1"), title: "Printer Voice", projectTitle: "Home Assistant" },
      {
        runtimeRequests: [
          request("r-approval", "command", "2026-10-08T01:00:00.000Z"),
          request("r-question", "user_input", "2026-10-08T00:00:00.000Z"),
          {
            ...(request("r-done", "command", "2026-10-07T00:00:00.000Z") as object),
            status: "resolved",
          } as never,
        ],
        turnItems: [
          {
            type: "approval_request",
            requestId: RuntimeRequestId.make("r-approval"),
            prompt: "git push --force-with-lease",
          },
          {
            type: "user_input_request",
            requestId: RuntimeRequestId.make("r-question"),
            questions: [{ id: "q", header: "Timer", question: "Did it stop?", options: [] }],
          },
        ] as never,
      },
    );
    expect(asks.map((ask) => [ask.kind, ask.requestId])).toEqual([
      ["question", "r-question"],
      ["approval", "r-approval"],
    ]);
    expect(asks[1]).toMatchObject({
      threadTitle: "Printer Voice",
      projectTitle: "Home Assistant",
      detail: "git push --force-with-lease",
    });
  });
});
