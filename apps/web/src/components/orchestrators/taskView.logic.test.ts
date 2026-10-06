import type { ProjectIssue, ProjectIssuesGetResult } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { TaskStatus } from "./projectRequests.logic";
import {
  deriveTaskView,
  encodeTaskRef,
  findListedIssue,
  olderServerTaskNote,
  parseTaskRef,
  pickAnswer,
  taskViewStatus,
} from "./taskView.logic";

function issue(number: number, overrides: Partial<ProjectIssue> = {}): ProjectIssue {
  return {
    host: "git.example",
    repository: "brad/printcell",
    number,
    title: `Task ${number}`,
    url: `https://git.example/brad/printcell/issues/${number}`,
    status: "pending",
    labels: ["ask", "ask:task"],
    isRequest: true,
    requestSource: { threadId: "asker" as never, rootThreadId: "root" as never, messageId: "m" },
    assignees: [],
    comments: 0,
    createdAt: "2026-10-04T10:00:00.000Z",
    updatedAt: "2026-10-04T10:00:00.000Z",
    closedAt: null,
    linkedThreadIds: [],
    ...overrides,
  };
}

const at = "2026-10-04T11:00:00.000Z";
const comment = (body: string) => ({ author: "agent", body, createdAt: at });

function result(
  main: ProjectIssue,
  overrides: Partial<ProjectIssuesGetResult> = {},
): ProjectIssuesGetResult {
  return { issue: main, body: "", comments: [], childNumbers: [], ...overrides };
}

describe("task refs", () => {
  it("round-trips and rejects anything else", () => {
    const ref = { host: "git.example", repository: "brad/printcell", number: 12 };
    expect(parseTaskRef(encodeTaskRef(ref))).toEqual(ref);
    expect(parseTaskRef("brad/printcell#12")).toBeNull();
    expect(parseTaskRef("git.example/brad/printcell#0")).toBeNull();
    expect(parseTaskRef(12)).toBeNull();
  });
});

describe("taskViewStatus", () => {
  it("prefers the shared status map, then derives from the issue", () => {
    const task = issue(1);
    expect(taskViewStatus(task, new Map([["brad/printcell#1", "for-review"]]))).toBe("for-review");
    expect(taskViewStatus(issue(2, { closedAt: at, status: "done" }), new Map())).toBe("complete");
    expect(taskViewStatus(issue(3, { stage: "ready" }), new Map())).toBe("for-review");
    expect(taskViewStatus(issue(4, { status: "in-progress" }), new Map())).toBe("active");
    expect(taskViewStatus(issue(5), new Map())).toBe("pending");
  });
});

describe("pickAnswer", () => {
  it("shows the thread reply while the work is open, never a progress note", () => {
    const task = issue(1, {
      answer: { text: "Service calls.", askedAt: at, answeredAt: at },
    });
    expect(pickAnswer(task, [comment("Progress: started")], "active")).toBe("Service calls.");
    expect(pickAnswer(issue(2), [comment("Progress: started")], "active")).toBeNull();
  });

  it("shows the agent's summary once the task is for review or complete", () => {
    const comments = [comment("Done: moved the box."), comment("Progress: tidying")];
    expect(pickAnswer(issue(1), comments, "for-review")).toBe("Done: moved the box.");
    expect(pickAnswer(issue(1, { closedAt: at }), comments, "complete")).toBe(
      "Done: moved the box.",
    );
  });

  it("strips the hidden request marker", () => {
    expect(pickAnswer(issue(1), [comment("Done.\n<!-- t3-request {} -->")], "for-review")).toBe(
      "Done.",
    );
  });
});

describe("deriveTaskView", () => {
  const statuses = new Map<string, TaskStatus>([
    ["brad/printcell#11", "complete"],
    ["brad/printcell#12", "active"],
  ]);

  it("lists an epic's children with their own status, skipping ones it cannot see", () => {
    const epic = issue(10, { labels: ["ask", "ask:plan"] });
    const view = deriveTaskView(
      result(epic, { childNumbers: [12, 11, 99] }),
      [issue(11), issue(12), issue(13)],
      statuses,
    );
    expect(view.children.map((child) => [child.issue.number, child.status])).toEqual([
      [11, "complete"],
      [12, "active"],
    ]);
    expect(view.kind).not.toBeNull();
  });

  it("shows the latest progress line while active and links each thread once", () => {
    const task = issue(12, { linkedThreadIds: ["worker" as never, "asker" as never] });
    const view = deriveTaskView(
      result(task, { comments: [comment("Progress: **half** done"), comment("Progress: nearly")] }),
      [task],
      statuses,
    );
    expect(view.status).toBe("active");
    expect(view.progress).toBe("nearly");
    expect(view.threadIds).toEqual(["asker", "worker"]);
  });

  it("hides progress once the work is complete", () => {
    const task = issue(11, { closedAt: at, status: "done" });
    const view = deriveTaskView(
      result(task, { comments: [comment("Progress: x")] }),
      [task],
      statuses,
    );
    expect(view.progress).toBeNull();
  });
});

describe("task panel on an older server", () => {
  it("finds the listed issue by host, repository and number", () => {
    const listed = [
      issue(7),
      issue(8, { repository: "brad/other" }),
      issue(8, { host: "other.example" }),
      issue(8),
    ];
    expect(
      findListedIssue(listed, { host: "git.example", repository: "brad/printcell", number: 8 }),
    ).toBe(listed[3]);
    expect(
      findListedIssue(listed, { host: "git.example", repository: "brad/printcell", number: 9 }),
    ).toBeNull();
  });

  it("names the fork release the server runs", () => {
    expect(olderServerTaskNote("0.0.45-nightly.20261002.2572-fork.26")).toBe(
      "This server is older (fork.26); update it to see full task details.",
    );
    expect(olderServerTaskNote("0.0.45")).toBe(
      "This server is older (0.0.45); update it to see full task details.",
    );
    expect(olderServerTaskNote(null)).toBe(
      "This server is older; update it to see full task details.",
    );
  });
});
