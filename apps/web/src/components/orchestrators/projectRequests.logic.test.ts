import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import type { ProjectIssue } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { deriveProjectRequests, requestKind } from "./projectRequests.logic";

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
    session: null,
    backgroundLiveness: null,
    latestTurn: null,
    ...overrides,
  } as unknown as EnvironmentThreadShell;
}

const tree = new Set(["root", "worker"]);

describe("deriveProjectRequests", () => {
  it("puts a request the agent marked ready in Brad's group for its kind", () => {
    const [question, plan] = deriveProjectRequests(
      [
        request(1, { status: "needs-review" }),
        request(2, { status: "needs-review", labels: ["ask", "ask:plan"] }),
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
          latestTurn: { state: "completed", completedAt: "2026-10-04T11:00:00.000Z" },
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
          session: { status: "running" },
          latestTurn: { state: "completed", completedAt: "2026-10-04T11:00:00.000Z" },
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
      [thread({ latestTurn: { state: "completed", completedAt: "2026-09-30T00:00:00.000Z" } })],
      tree,
      NOW,
    );
    expect(item).toMatchObject({ forYou: null, leftBehind: true });
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
