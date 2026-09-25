import { describe, expect, it } from "vite-plus/test";

import { buildUserInputAnswers, findPendingRequests, resolveCreateParent } from "../src/nesting.js";

const thread = (id: string, overrides: Record<string, unknown> = {}) => ({
  id,
  projectId: "project-1",
  parentThreadId: null,
  archivedAt: null,
  deletedAt: null,
  ...overrides,
});

const create = (overrides: Partial<Parameters<typeof resolveCreateParent>[0]> = {}) =>
  resolveCreateParent({
    explicitParentThreadId: null,
    topLevel: false,
    serverSupportsNesting: true,
    callerThreadId: "orchestrator",
    projectId: "project-1",
    threads: [thread("orchestrator")],
    ...overrides,
  });

describe("resolveCreateParent", () => {
  it("nests a worker under the calling thread by default", () => {
    expect(create()).toEqual({ parentThreadId: "orchestrator", reason: "caller" });
  });

  it("keeps a worker top-level when asked or when there is no caller", () => {
    expect(create({ topLevel: true }).parentThreadId).toBeNull();
    expect(create({ callerThreadId: null }).parentThreadId).toBeNull();
  });

  it("reports top-level instead of claiming a nest on servers without nesting", () => {
    expect(create({ serverSupportsNesting: false })).toMatchObject({
      parentThreadId: null,
      reason: "this environment's server does not support nesting yet",
    });
  });

  it("honors an explicit parent over the caller", () => {
    expect(create({ explicitParentThreadId: "lead" })).toEqual({
      parentThreadId: "lead",
      reason: "explicit",
    });
  });

  it("stays top-level when the caller is in another project or environment", () => {
    expect(create({ projectId: "project-2" })).toMatchObject({
      parentThreadId: null,
      reason: "calling thread is in another project",
    });
    expect(create({ threads: [] })).toMatchObject({
      parentThreadId: null,
      reason: "calling thread is in another environment",
    });
  });

  it("joins the caller's parent when the caller is itself nested", () => {
    const threads = [thread("lead"), thread("orchestrator", { parentThreadId: "lead" })];
    expect(create({ threads })).toEqual({ parentThreadId: "lead", reason: "caller-parent" });
  });
});

const activity = (kind: string, payload: Record<string, unknown>, createdAt = "2026-01-01") => ({
  kind,
  createdAt,
  payload,
});

describe("findPendingRequests", () => {
  it("lists open questions and approvals oldest first and drops resolved or stale ones", () => {
    const pending = findPendingRequests([
      activity("approval.requested", { requestId: "a1", detail: "rm -rf build" }, "2026-01-02"),
      activity(
        "user-input.requested",
        { requestId: "q1", questions: [{ id: "color", question: "Which color?", options: [] }] },
        "2026-01-01",
      ),
      activity("approval.requested", { requestId: "a2" }),
      activity("approval.resolved", { requestId: "a2" }),
      activity("user-input.requested", {
        requestId: "q2",
        questions: [{ id: "x", question: "Stale?" }],
      }),
      activity("provider.user-input.respond.failed", {
        requestId: "q2",
        detail: "Stale pending user-input request",
      }),
    ]);
    expect(pending.map((request) => request.requestId)).toEqual(["q1", "a1"]);
  });
});

describe("buildUserInputAnswers", () => {
  const one = [{ id: "color", question: "Which color?", options: [] }];
  const two = [...one, { id: "size", question: "Which size?", options: [] }];

  it("uses free text for a single question", () => {
    expect(buildUserInputAnswers({ questions: one, text: "blue", pairs: [] })).toEqual({
      color: "blue",
    });
  });

  it("requires an answer for every question when there are several", () => {
    expect(() => buildUserInputAnswers({ questions: two, text: "blue", pairs: [] })).toThrow(
      "Answer every question",
    );
    expect(
      buildUserInputAnswers({ questions: two, text: "", pairs: ["color=blue", "size=large"] }),
    ).toEqual({ color: "blue", size: "large" });
  });

  it("rejects an unknown question id", () => {
    expect(() =>
      buildUserInputAnswers({ questions: one, text: "", pairs: ["shape=round"] }),
    ).toThrow("Unknown question id");
  });
});
