import { describe, expect, it } from "vite-plus/test";

import { parseDecisionIssue, planBradAnswer, resolveWaitingThread } from "./decisions.logic.ts";

const BODY = [
  "A Windows Update installed a new NVIDIA driver at 10:42 and WSL lost the GPU.",
  "Parakeet is down and Ollama is running on the CPU.",
  "",
  "```decision",
  "waiting: printcell",
  "options:",
  "- Restart WSL now, reboot if that fails [recommended]",
  "- Reboot the desktop now",
  "- Leave it until tonight",
  "```",
].join("\n");

describe("parseDecisionIssue", () => {
  it("reads context, waiting and options with the recommended one marked", () => {
    expect(parseDecisionIssue(BODY)).toEqual({
      context:
        "A Windows Update installed a new NVIDIA driver at 10:42 and WSL lost the GPU.\nParakeet is down and Ollama is running on the CPU.",
      waiting: "printcell",
      options: [
        { text: "Restart WSL now, reboot if that fails", recommended: true },
        { text: "Reboot the desktop now", recommended: false },
        { text: "Leave it until tonight", recommended: false },
      ],
    });
  });

  it("defaults waiting and treats a missing options list as an open question", () => {
    expect(parseDecisionIssue("Which model?\n\n```decision\n```")).toEqual({
      context: "Which model?",
      waiting: "chief-of-staff-inbox",
      options: [],
    });
  });

  it("keeps a body without a block as the context of an open question", () => {
    expect(parseDecisionIssue("Plain text <!-- hidden -->")).toEqual({
      context: "Plain text",
      waiting: "chief-of-staff-inbox",
      options: [],
    });
    expect(parseDecisionIssue(null).options).toEqual([]);
  });

  it("marks only the first recommended option, caps at five, and needs two to be a choice", () => {
    const many = [
      "```decision",
      "options:",
      ...["a [recommended]", "b [recommended]", "c", "d", "e", "f"].map((o) => `- ${o}`),
      "```",
    ].join("\n");
    const parsed = parseDecisionIssue(many);
    expect(parsed.options.map((o) => o.text)).toEqual(["a", "b", "c", "d", "e"]);
    expect(parsed.options.map((o) => o.recommended)).toEqual([true, false, false, false, false]);
    expect(parseDecisionIssue("```decision\noptions:\n- only one\n```").options).toEqual([]);
  });
});

describe("planBradAnswer", () => {
  const base = { title: "Restart WSL?", reference: "brad/x#152", url: "https://g/x/issues/152" };

  it("comments the chosen option with the note and sends the same text with the reference", () => {
    const plan = planBradAnswer({
      ...base,
      decision: "option",
      option: "Reboot",
      note: "  after lunch ",
    });
    expect(plan?.comment).toBe("Brad chose: Reboot\n\nafter lunch");
    expect(plan?.message).toBe(
      'Brad chose: Reboot\n\nafter lunch\n\nOn brad/x#152 "Restart WSL?" (https://g/x/issues/152).',
    );
  });

  it("answers an open question in Brad's words", () => {
    expect(
      planBradAnswer({ ...base, decision: "answer", answer: "the  tool diameter" })?.comment,
    ).toBe("Brad answered: the tool diameter");
  });

  it("has nothing to send without an option or answer", () => {
    expect(planBradAnswer({ ...base, decision: "option" })).toBeNull();
    expect(planBradAnswer({ ...base, decision: "answer", answer: "  " })).toBeNull();
  });
});

describe("resolveWaitingThread", () => {
  const thread = (id: string, title: string, over: object = {}) => ({
    id,
    title,
    projectId: "p1",
    updatedAt: "2026-10-01T00:00:00.000Z",
    archivedAt: null,
    ...over,
  });
  const threads = [
    thread("t-old", "Chief of Staff inbox"),
    thread("t-new", "Chief of Staff inbox", { updatedAt: "2026-10-04T00:00:00.000Z" }),
    thread("t-gone", "Chief of Staff inbox", { archivedAt: "2026-10-05T00:00:00.000Z" }),
    thread("t-agent", "Printcell", { projectId: "pa" }),
    thread("t-child", "Printcell child", { projectId: "pa", parentThreadId: "t-agent" }),
  ];
  const projects = [{ id: "pa", permanentAgent: { name: "printcell" } }];

  it("finds a thread by id, by agent name, or by title slug (newest live one)", () => {
    expect(resolveWaitingThread("t-old", threads, projects)).toBe("t-old");
    expect(resolveWaitingThread("printcell", threads, projects)).toBe("t-agent");
    expect(resolveWaitingThread("chief-of-staff-inbox", threads, projects)).toBe("t-new");
  });

  it("is null when nothing matches or the match is archived", () => {
    expect(resolveWaitingThread("nobody", threads, projects)).toBeNull();
    expect(resolveWaitingThread("t-gone", threads, projects)).toBeNull();
    expect(resolveWaitingThread(" ", threads, projects)).toBeNull();
  });
});
