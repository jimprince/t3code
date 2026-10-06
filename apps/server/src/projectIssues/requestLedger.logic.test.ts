import type { ProjectIssue, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { parseRequestMarker } from "./projectIssues.logic.ts";
import {
  answerToMessage,
  buildIntakeBrief,
  intakeModelSelection,
  capturableMessage,
  clampTitle,
  decisionThreadId,
  fallbackRequestItem,
  formatRequestIssueBody,
  isObviouslyNotARequest,
  formatFollowUpComment,
  parseRequestReference,
  planDecision,
  planRequestItem,
  progressLineFor,
  requestCandidates,
} from "./requestLedger.logic.ts";
import { buildRequestItemsPrompt } from "../textGeneration/RequestItemsPrompt.ts";

function turnStart(text: string, extra: Record<string, unknown> = {}) {
  return {
    type: "message.dispatch",
    threadId: "thread-1",
    messageId: "m-1",
    text,
    ...extra,
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
    expect(
      capturableMessage(turnStart("Draft ideas", { senderThreadId: "thread-2" }), "desktop"),
    ).toBeNull();
    expect(
      capturableMessage(turnStart("Draft ideas", { scheduledTaskId: "task-1" }), "desktop"),
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

describe("planDecision", () => {
  const subject = { title: "V2 port plan", url: "https://git.example/brad/t3code/issues/7" };

  it("approves by starting the work and telling the thread to go ahead", () => {
    const plan = planDecision({ decision: "approve", ...subject });
    expect(plan).toMatchObject({ comment: "Approved by Brad", status: "in-progress" });
    expect(plan?.message).toContain("V2 port plan");
    expect(plan?.message).toContain(subject.url);
  });

  it("records the chosen option in the comment and the message", () => {
    const plan = planDecision({
      decision: "option",
      option: "Option B:  port in two steps",
      ...subject,
    });
    expect(plan).toMatchObject({
      comment: "Brad chose: Option B: port in two steps",
      status: "in-progress",
    });
    expect(plan?.message).toContain("Option B: port in two steps");
  });

  it("needs an option to choose one", () => {
    expect(planDecision({ decision: "option", ...subject })).toBeNull();
    expect(planDecision({ decision: "option", option: "  ", ...subject })).toBeNull();
  });

  it("sends Not yet back to Pending with the reason and tells no thread", () => {
    expect(planDecision({ decision: "not-yet", reason: "after the\nV2 port", ...subject })).toEqual(
      {
        comment: "Not yet: after the V2 port",
        status: "pending",
        message: null,
      },
    );
    expect(planDecision({ decision: "not-yet", ...subject })).toMatchObject({
      comment: "Not yet",
      status: "pending",
    });
  });
});

describe("decisionThreadId", () => {
  const live = new Set(["root", "worker", "other"]);

  it("goes to the linked worker, not the orchestrator", () => {
    expect(decisionThreadId(["root", "worker", "other"], "root", live)).toBe("worker");
  });

  it("skips archived or unknown threads and falls back to the orchestrator", () => {
    expect(decisionThreadId(["gone", "worker"], "root", live)).toBe("worker");
    expect(decisionThreadId(["gone"], "root", live)).toBe("root");
    expect(decisionThreadId([], "root", live)).toBe("root");
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

  it("without a model, follows the thread's only linked issue and otherwise files nothing", () => {
    const unsplit = { explicit: false, candidates, unsplit: true };
    expect(planRequestItem({ kind: "deliverable" }, unsplit)).toEqual({
      action: "comment",
      number: 17,
    });
    // An orchestrator thread linked to many issues: the topic is unknown.
    const busy = [...candidates, { number: 18, title: "Another", inThread: true }];
    expect(planRequestItem({ kind: "deliverable" }, { ...unsplit, candidates: busy })).toEqual({
      action: "skip",
    });
    expect(
      planRequestItem({ kind: "deliverable" }, { ...unsplit, candidates: [candidates[1]!] }),
    ).toEqual({ action: "skip" });
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

describe("each question's own answer", () => {
  const message = (
    messageId: string,
    role: string,
    turnId: string | null,
    minute: number,
    text = messageId,
    isStreaming = false,
  ) => ({
    messageId,
    role,
    turnId,
    text,
    isStreaming,
    createdAt: `2026-10-05T07:${String(minute).padStart(2, "0")}:00.000Z`,
  });

  const thread = [
    message("q1", "user", "t1", 0, "In Home Assistant, what does an automation run?"),
    message("a1-start", "assistant", "t1", 1, "Let me check."),
    message("a1", "assistant", "t1", 2, "Its actions: service calls or scripts."),
    message("q2", "user", "t2", 3, "How is the release going?"),
    message("a2", "assistant", "t2", 4, "1 of 4 complete."),
    message("q3", "user", "t3", 5, "And the canvas?"),
    message("a3", "assistant", "t3", 6, "Still writing", true),
  ];

  it("answers each question with the last reply of the turn it started", () => {
    expect(answerToMessage(thread, "q1")).toEqual({
      text: "Its actions: service calls or scripts.",
      askedAt: "2026-10-05T07:00:00.000Z",
      answeredAt: "2026-10-05T07:02:00.000Z",
    });
    expect(answerToMessage(thread, "q2")?.text).toBe("1 of 4 complete.");
  });

  it("waits while the reply streams, and has none for an unknown message", () => {
    expect(answerToMessage(thread, "q3")).toBeNull();
    expect(answerToMessage(thread, "missing")).toBeNull();
  });

  it("without a turn id, takes the reply before the next user message", () => {
    const untracked = [
      message("q", "user", null, 0),
      message("a", "assistant", null, 1, "Yes."),
      message("next", "user", null, 2),
      message("later", "assistant", null, 3, "Something else."),
    ];
    expect(answerToMessage(untracked, "q")?.text).toBe("Yes.");
  });
});

describe("New request intake", () => {
  const provider = (
    instanceId: string,
    driver: string,
    slugs: ReadonlyArray<string>,
    usable = true,
  ) => ({
    instanceId,
    driver,
    enabled: usable,
    installed: usable,
    models: slugs.map((slug) => ({ slug })),
  });
  const orchestrators = { instanceId: "codex", model: "gpt-6.1-sol" };

  it("triages with Sonnet 5.5 when offered, another Claude Sonnet next, else the orchestrator's model", () => {
    expect(
      intakeModelSelection(
        [
          provider("codex", "codex", ["gpt-6.1-sol"]),
          provider("claude", "claude", ["claude-opus-5-5", "claude-sonnet-5-5"]),
        ],
        orchestrators,
      ),
    ).toEqual({ instanceId: "claude", model: "claude-sonnet-5-5" });
    expect(
      intakeModelSelection([provider("claude", "claude", ["claude-sonnet-5"])], orchestrators),
    ).toEqual({ instanceId: "claude", model: "claude-sonnet-5" });
    expect(
      intakeModelSelection(
        [provider("claude", "claude", ["claude-sonnet-5-5"], false)],
        orchestrators,
      ),
    ).toBe(orchestrators);
  });

  it("briefs the intake to triage, settle itself and only hand on what cannot wait", () => {
    const brief = buildIntakeBrief({
      projectTitle: "t3code-fork",
      orchestratorThreadId: "root-1",
      orchestratorTitle: "T3 Orchestrator",
      projectId: "project-1",
    });
    expect(brief).toContain('t3-thread request type "$T3_THREAD_ID" N');
    expect(brief).toContain('t3-thread roadmap move "$T3_THREAD_ID" N next');
    expect(brief).toContain("--parent root-1 --notify root-1 --notify-level attention");
    expect(brief).toContain("Do not message the orchestrator.");
    expect(brief).toContain('t3-thread settle "$T3_THREAD_ID" --self');
    expect(brief.trimEnd().endsWith("Brad's request:")).toBe(true);
  });
});
