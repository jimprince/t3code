import { describe, expect, it } from "vite-plus/test";
import {
  ThreadId,
  RuntimeRequestId,
  type ProjectIssue,
  type ProjectPendingAsk,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { aggregate } from "./aggregation.ts";

const root = ThreadId.make("root");
const now = "2026-10-15T10:00:00.000Z";
const row = (number: number, labels: string[]): ProjectIssue => ({
  host: "git.test",
  repository: "brad/repo",
  number,
  title: `Task ${number}`,
  url: `https://git.test/brad/repo/issues/${number}`,
  status: "pending",
  stage: "ready",
  labels,
  isRequest: true,
  requestSource: null,
  createdAt: now,
  updatedAt: now,
  closedAt: null,
  comments: 0,
  linkedThreadIds: [],
  assignees: [],
});
const build = (issues: ProjectIssue[], asks: ProjectPendingAsk[] = []) =>
  aggregate({
    shells: [
      { id: root, title: "Dashboard", archivedAt: null, updatedAt: DateTime.makeUnsafe(now) },
    ],
    metadata: [{ threadId: root, parentThreadId: null, subproject: "on" }],
    issues: new Map([[root, issues]]),
    now,
    plans: [],
    samples: [],
    sources: [],
    pendingAsks: asks,
  });

describe("dashboard and tray inline answer data (#355)", () => {
  it("keeps canonical proposed test labels verbatim with their Passed/Failed semantics", () => {
    const issue = {
      ...row(1, ["ask:task", "needs-test"]),
      readyComment: {
        author: "agent",
        createdAt: now,
        body: "Shipped the widened strip for review.\nWhat you are judging and where: Test the tray in Dev after Update #355.\nOption A: Passed\nOption B: Failed\nRecommended: Option A",
      },
    };
    expect(build([issue]).projects[0]!.attention[0]?.options).toEqual([
      { text: "Passed", recommended: true, action: "approve", effect: "settle" },
      { text: "Failed", recommended: false, action: "reject" },
    ]);
  });
  it("distinguishes finished-work approval from plan approval and supplies every default", () => {
    const snapshot = build([
      row(1, ["ask:task", "needs-review"]),
      row(2, ["ask:epic", "needs-review"]),
      row(3, ["ask:question", "needs-review"]),
      row(4, ["ask:task", "needs-test"]),
    ]);
    const items = snapshot.projects[0]!.attention;
    expect(items.map((item) => item.answer)).toEqual([
      "issue-review",
      "issue-approve",
      "issue-read",
      "issue-test",
    ]);
    expect(items.map((item) => item.options.map((option) => option.text))).toEqual([
      ["Approve and close", "Reject"],
      ["Approve: go ahead", "Not yet"],
      ["Got it", "Follow up"],
      ["Passed", "Failed"],
    ]);
    expect(items[0]?.options[0]).toMatchObject({ action: "approve", effect: "settle" });
    expect(items[1]?.options[0]).toMatchObject({ action: "approve", effect: "start" });
    expect(items.every((item) => item.kind === "review" || item.kind === "test")).toBe(true);
  });
  it("retains the ready summary and proposed text verbatim when a Curator comment is newer", () => {
    const issue = {
      ...row(1, ["ask:task", "needs-review"]),
      latestComment: { author: "curator", body: "Curator: re-ranked the backlog", createdAt: now },
      readyComment: {
        author: "agent",
        body: "Built the smaller design. Check the linked change.\nOption A: Keep all three outputs\nOption B: Ship the smaller version\nRecommended: Option B",
        createdAt: now,
      },
    };
    const attention = build([issue]).projects[0]!.attention[0]!;
    expect(attention.question).toBe("Built the smaller design. Check the linked change.");
    expect(attention.options).toEqual([
      { text: "Keep all three outputs", recommended: false, action: "option" },
      { text: "Ship the smaller version", recommended: true, action: "option" },
    ]);
  });
  it("flags a missing or title-only explanation rather than repeating the title", () => {
    for (const body of [undefined, "Task 1"]) {
      const issue = {
        ...row(1, ["ask:task", "needs-review"]),
        ...(body ? { readyComment: { body, author: "agent", createdAt: now } } : {}),
      };
      expect(build([issue]).projects[0]!.attention[0]).toMatchObject({
        summary: "",
        question: "",
        judgingWhere: null,
        recommended: null,
        asksNothingYet: true,
      });
    }
  });
  it("retains ids and constraints for every question rather than only flattened labels", () => {
    const questions = ["first", "second"].map((id) => ({
      id,
      header: id,
      question: `Choose ${id}`,
      options: [
        { label: `${id} A`, description: "First" },
        { label: `${id} B`, description: "Second" },
      ],
      multiSelect: id === "second",
      allowCustomAnswer: true,
    }));
    const snapshot = build(
      [],
      [
        {
          threadId: root,
          threadTitle: "Dashboard",
          projectTitle: "Dashboard",
          requestId: RuntimeRequestId.make("ask-1"),
          createdAt: now,
          canRespond: true,
          kind: "question",
          questions,
          messageResponse: true,
        },
      ],
    );
    const attention = snapshot.projects[0]!.attention[0]!;
    expect(attention).toMatchObject({
      kind: "question",
      answer: "thread-question",
      questions,
      messageResponse: true,
    });
    expect(attention.options).toHaveLength(4);
  });
});
