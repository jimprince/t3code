import type { ProjectIssue, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { parseRequestMarker } from "./projectIssues.logic.ts";
import {
  capturableMessage,
  clampTitle,
  fallbackRequestItem,
  formatRequestIssueBody,
  isObviouslyNotARequest,
  formatFollowUpComment,
  parseRequestReference,
  planRequestItem,
  progressLineFor,
  requestCandidates,
} from "./requestLedger.logic.ts";
import { buildRequestItemsPrompt } from "../textGeneration/RequestItemsPrompt.ts";

function turnStart(text: string, extra: Record<string, unknown> = {}) {
  return {
    type: "thread.turn.start",
    threadId: "thread-1",
    message: { messageId: "m-1", role: "user", text, ...extra },
  };
}

describe("capturableMessage", () => {
  it("captures a user message typed in a UI client", () => {
    for (const surface of ["web", "desktop", "mobile"]) {
      expect(capturableMessage(turnStart("Draft ten dinosaur flexi ideas"), surface)).toEqual({
        threadId: "thread-1",
        messageId: "m-1",
        text: "Draft ten dinosaur flexi ideas",
      });
    }
  });

  it("ignores the CLI, agent sends, worker briefs, page agents and other commands", () => {
    expect(capturableMessage(turnStart("Draft ideas"), undefined)).toBeNull();
    expect(capturableMessage(turnStart("Draft ideas"), "cli")).toBeNull();
    expect(
      capturableMessage(
        turnStart("Draft ideas", { context: { records: [{ kind: "t3-origin" }] } }),
        "desktop",
      ),
    ).toBeNull();
    expect(
      capturableMessage(turnStart("You are a T3 worker thread. Before acting..."), "desktop"),
    ).toBeNull();
    expect(
      capturableMessage({ ...turnStart("Draft ideas"), threadId: "page-agent-x" }, "desktop"),
    ).toBeNull();
    expect(capturableMessage({ type: "thread.create", threadId: "t" }, "desktop")).toBeNull();
  });
});

describe("isObviouslyNotARequest", () => {
  it("skips nudges and acknowledgements without a model call", () => {
    for (const text of ["Do it.", "continue", "Looks good!", "ok", "How?"]) {
      expect(isObviouslyNotARequest(text)).toBe(true);
    }
    expect(isObviouslyNotARequest("Can we connect the ReSpeaker to the ChatGPT app?")).toBe(false);
  });
});

describe("fallbackRequestItem", () => {
  it("files the first sentence as the title and guesses question vs deliverable", () => {
    expect(fallbackRequestItem("Can we connect the ReSpeaker? It would help.")).toMatchObject({
      title: "Can we connect the ReSpeaker?",
      kind: "question",
    });
    expect(fallbackRequestItem("Draft 10 of these\nwith variety").kind).toBe("deliverable");
  });

  it("clamps long titles", () => {
    expect(clampTitle("x".repeat(200))).toHaveLength(90);
  });
});

describe("formatRequestIssueBody", () => {
  it("quotes Brad's words, names the threads and carries a parseable marker", () => {
    const source = {
      threadId: "worker" as ThreadId,
      rootThreadId: "root" as ThreadId,
      messageId: "m-1",
    };
    const body = formatRequestIssueBody({
      excerpt: "Can we connect the ReSpeaker?",
      kind: "question",
      threadTitle: "Audio worker",
      rootTitle: "Printcell Orchestrator",
      source,
    });
    expect(body).toContain("> Can we connect the ReSpeaker?");
    expect(body).toContain("**Audio worker** (under **Printcell Orchestrator**)");
    expect(parseRequestMarker(body)).toEqual(source);
  });
});

describe("parseRequestReference", () => {
  const tracker = { host: "git.bradleyprince.com", repository: "brad/printcell" };

  it("reads numbers in the tracker, owner/repo#N and same-host URLs", () => {
    expect(parseRequestReference("12", tracker)).toEqual({
      repository: "brad/printcell",
      number: 12,
    });
    expect(parseRequestReference("#7", tracker)).toEqual({
      repository: "brad/printcell",
      number: 7,
    });
    expect(parseRequestReference("Brad/Other#3", tracker)).toEqual({
      repository: "brad/other",
      number: 3,
    });
    expect(
      parseRequestReference("https://git.bradleyprince.com/brad/printcell/issues/9", tracker),
    ).toEqual({ repository: "brad/printcell", number: 9 });
  });

  it("rejects other hosts and malformed references", () => {
    expect(parseRequestReference("https://github.com/brad/printcell/issues/9", tracker)).toBeNull();
    expect(parseRequestReference("0", tracker)).toBeNull();
    expect(parseRequestReference("printcell", tracker)).toBeNull();
  });
});

describe("progressLineFor", () => {
  it("records a progress line for stage changes that carry no text", () => {
    expect(progressLineFor("in-progress")).toBe("Progress: started");
    expect(progressLineFor("awaiting-release")).toMatch(/next release/);
    expect(progressLineFor("needs-test")).toBeNull();
    expect(progressLineFor(undefined)).toBeNull();
  });
});

describe("follow-ups instead of an issue per message", () => {
  const issue = (number: number, overrides: Partial<ProjectIssue> = {}): ProjectIssue =>
    ({
      host: "git.example",
      repository: "brad/gpu-transcriber",
      number,
      title: `Issue ${number}`,
      url: `https://git.example/brad/gpu-transcriber/issues/${number}`,
      status: "pending",
      labels: [],
      isRequest: false,
      requestSource: null,
      assignees: [],
      comments: 0,
      createdAt: "2026-10-05T00:00:00.000Z",
      updatedAt: `2026-10-05T00:00:${String(number).padStart(2, "0")}.000Z`,
      closedAt: null,
      linkedThreadIds: [],
      ...overrides,
    }) as ProjectIssue;

  it("offers the thread's linked issues first, then the project's open requests", () => {
    const candidates = requestCandidates(
      [
        issue(17, { linkedThreadIds: ["voice" as ThreadId] }),
        issue(30, { isRequest: true }),
        issue(31),
        issue(32, { isRequest: true, closedAt: "2026-10-05T01:00:00.000Z" }),
      ],
      "voice",
    );
    expect(candidates).toEqual([
      { number: 17, title: "Issue 17", inThread: true },
      { number: 30, title: "Issue 30", inThread: false },
    ]);
  });

  const candidates = [
    { number: 17, title: "Live chat", inThread: true },
    { number: 30, title: "Bed temperature", inThread: false },
  ];

  it("comments follow-ups on the issue they continue and files only new work", () => {
    const chat = { explicit: false, candidates, unsplit: false };
    expect(planRequestItem({ kind: "change", existing: 17 }, chat)).toEqual({
      action: "comment",
      number: 17,
    });
    expect(planRequestItem({ kind: "deliverable", existing: 30 }, chat)).toEqual({
      action: "comment",
      number: 30,
    });
    expect(planRequestItem({ kind: "feature", existing: null }, chat)).toEqual({ action: "file" });
    // A number the model invented is not an open issue: new work.
    expect(planRequestItem({ kind: "feature", existing: 99 }, chat)).toEqual({ action: "file" });
  });

  it("never files questions from chat, but files everything from the New request box", () => {
    const chat = { explicit: false, candidates, unsplit: false };
    expect(planRequestItem({ kind: "question", existing: null }, chat)).toEqual({ action: "skip" });
    expect(planRequestItem({ kind: "question", existing: 17 }, chat)).toEqual({ action: "skip" });
    const box = { explicit: true, candidates, unsplit: false };
    expect(planRequestItem({ kind: "question", existing: 17 }, box)).toEqual({ action: "file" });
  });

  it("without a model, follows the thread's newest linked issue", () => {
    const unsplit = { explicit: false, candidates, unsplit: true };
    expect(planRequestItem({ kind: "deliverable" }, unsplit)).toEqual({
      action: "comment",
      number: 17,
    });
    expect(
      planRequestItem({ kind: "deliverable" }, { ...unsplit, candidates: [candidates[1]!] }),
    ).toEqual({ action: "file" });
  });

  it("quotes the follow-up with a hidden marker", () => {
    const body = formatFollowUpComment({
      excerpt: "Just do the full version, number two.",
      threadTitle: "Voice assistant",
      messageId: "m-9",
      item: 0,
    });
    expect(body).toContain("Follow-up from Brad in **Voice assistant**:");
    expect(body).toContain("> Just do the full version, number two.");
    expect(body).toContain('<!-- t3-request-followup {"messageId":"m-9","item":0} -->');
  });

  it("lists the open issues for the model, marking the conversation's own", () => {
    const { prompt } = buildRequestItemsPrompt({ message: "Did it work?", candidates });
    expect(prompt).toContain("#17 (this conversation): Live chat");
    expect(prompt).toContain("#30: Bed temperature");
    expect(buildRequestItemsPrompt({ message: "x" }).prompt).toContain("Open issues: none.");
  });
});
