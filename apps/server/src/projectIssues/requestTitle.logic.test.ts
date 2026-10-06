import type { ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  cleanRequestTitle,
  deriveRequestTitle,
  isRawTitle,
  MAX_TITLE_LENGTH,
  planRetitle,
  requestWords,
} from "./requestTitle.logic.ts";
import { formatRequestIssueBody } from "./requestLedger.logic.ts";

describe("deriveRequestTitle", () => {
  const cases: ReadonlyArray<readonly [string, string, "question" | "task"]> = [
    [
      "Can you get T3 orchestrator to troubleshoot this?",
      "Get T3 orchestrator to troubleshoot this",
      "task",
    ],
    [
      "Hey, can you please look into why the dashboard is slow? Thanks!",
      "Look into why the dashboard is slow",
      "task",
    ],
    ["please fix the stuck wizard step", "Fix the stuck wizard step", "task"],
    ["Fix the stuck wizard step, please.", "Fix the stuck wizard step", "task"],
    [
      "I want the Needs you section to show decisions first.",
      "The Needs you section to show decisions first",
      "task",
    ],
    [
      "I would like you to move the New request box to the top.",
      "Move the New request box to the top",
      "task",
    ],
    [
      "Let's port the roadmap widget to the new layout",
      "Port the roadmap widget to the new layout",
      "task",
    ],
    [
      "Can we connect the ReSpeaker to the ChatGPT app?",
      "Can we connect the ReSpeaker to the ChatGPT app?",
      "question",
    ],
    ["What's the status of the release?", "What's the status of the release?", "question"],
    ["why did the nightly deploy fail", "Why did the nightly deploy fail", "task"],
    [
      "Ok so, the sidebar keeps flickering. Can you look at it? It started yesterday.",
      "The sidebar keeps flickering",
      "task",
    ],
    ["Hey.\n\nCan you draft 10 of these\nwith variety", "Draft 10 of these", "task"],
    [
      "Thanks! Now please bump the version to v0.0.30. Then deploy it.",
      "Bump the version to v0.0.30",
      "task",
    ],
    ["See e.g. the old board and rebuild it", "See e.g. the old board and rebuild it", "task"],
    ["🔥🔥 can you fix the **build** 🙏", "Fix the build", "task"],
    [
      "Can you review https://git.example.com/brad/repo/pulls/12/files today?",
      "Review git.example.com today",
      "task",
    ],
    ["pnpm install fails on the VM", "pnpm install fails on the VM", "task"],
    ["I was wondering if you could add a dark mode toggle", "Add a dark mode toggle", "task"],
  ];

  it.each(cases)("%j -> %j", (text, title, kind) => {
    expect(deriveRequestTitle(text)).toEqual({ title, kind });
  });

  it("caps a very long message at a word boundary under the limit", () => {
    const { title } = deriveRequestTitle(
      "Can you rework the whole project page so that every widget shows its own status, its own progress line and its owner in one place",
    );
    expect(title.length).toBeLessThanOrEqual(MAX_TITLE_LENGTH);
    expect(title.endsWith("...")).toBe(true);
    expect(title.startsWith("Rework the whole project page")).toBe(true);
    expect(title).not.toMatch(/\s\.\.\.$/);
    const words = title.slice(0, -3).split(" ");
    expect(
      "rework the whole project page so that every widget shows its own status, its own progress line and its owner in one place",
    ).toContain(words.at(-1)!.toLowerCase());
  });

  it("falls back to the raw first line when every sentence is filler", () => {
    expect(deriveRequestTitle("Okay.\nthanks!").title).toBe("Okay.");
    expect(deriveRequestTitle("   ").title).toBe("New request");
  });

  it("lets a stored kind override the guess", () => {
    expect(deriveRequestTitle("Why did the deploy fail?", "task")).toEqual({
      title: "Why did the deploy fail",
      kind: "task",
    });
    expect(deriveRequestTitle("Can you tell me why it failed?", "question")).toEqual({
      title: "Can you tell me why it failed?",
      kind: "question",
    });
  });
});

describe("cleanRequestTitle", () => {
  it("cleans model output by kind", () => {
    expect(cleanRequestTitle("  Please troubleshoot the T3 orchestrator.  ", "task")).toBe(
      "Troubleshoot the T3 orchestrator",
    );
    expect(cleanRequestTitle("Can you move the box?", "task")).toBe("Move the box");
    expect(cleanRequestTitle("Why did the deploy fail", "question")).toBe(
      "Why did the deploy fail",
    );
    expect(cleanRequestTitle("Hey, why did the deploy fail??", "question")).toBe(
      "Why did the deploy fail?",
    );
    expect(cleanRequestTitle("Plan the iOS release...", "epic")).toBe("Plan the iOS release");
  });

  it("leaves a good title alone and drops filler-only text", () => {
    expect(cleanRequestTitle("Add a dark mode toggle to settings", "task")).toBe(
      "Add a dark mode toggle to settings",
    );
    expect(cleanRequestTitle("Okay!", "task")).toBe("");
  });

  it("never ends a capped title on a connector", () => {
    const title = cleanRequestTitle(
      "Move the New request box to the top of the project page and then remove the old one",
      "task",
    );
    expect(title.length).toBeLessThanOrEqual(MAX_TITLE_LENGTH);
    expect(title).toBe("Move the New request box to the top of the project page and then...");
  });
});

describe("planRetitle", () => {
  const source = (messageId: string) => ({
    threadId: "t" as ThreadId,
    rootThreadId: "r" as ThreadId,
    messageId,
  });
  const bodyOf = (excerpt: string, messageId = "m-1") =>
    formatRequestIssueBody({
      excerpt,
      kind: "task",
      threadTitle: "Chat",
      rootTitle: null,
      source: source(messageId),
    });

  const raw = "Can you get T3 orchestrator to troubleshoot this?\nIt hangs on start.";

  it("files Brad's words under their own heading", () => {
    const body = bodyOf(raw);
    expect(body.startsWith("## Brad's words\n\n> Can you get T3")).toBe(true);
    expect(requestWords(body)).toBe(raw);
    expect(body).toContain("<!-- t3-request ");
  });

  it("reads the quote of an issue filed before the heading", () => {
    expect(requestWords("> one\n> two\n\nRequested in **Chat**.")).toBe("one\ntwo");
    expect(requestWords("No quote here")).toBeNull();
  });

  it("replaces a raw title, whole or cut", () => {
    expect(
      planRetitle({
        title: "Can you get T3 orchestrator to troubleshoot this?",
        body: bodyOf(raw),
      }),
    ).toBe("Get T3 orchestrator to troubleshoot this");
    expect(
      planRetitle({ title: "Can you get T3 orchestrator to troubleshoot...", body: bodyOf(raw) }),
    ).toBe("Get T3 orchestrator to troubleshoot this");
  });

  it("keeps a question a question when the issue is typed one", () => {
    expect(
      planRetitle({
        title: "Hey, can you tell me why the deploy failed?",
        body: bodyOf("Hey, can you tell me why the deploy failed?"),
        kind: "question",
      }),
    ).toBe("Can you tell me why the deploy failed?");
    expect(
      planRetitle({
        title: "Why did the deploy fail?",
        body: bodyOf("Why did the deploy fail?"),
        kind: "question",
      }),
    ).toBeNull();
    expect(
      planRetitle({
        title: "Can we connect the ReSpeaker?",
        body: bodyOf("Can we connect the ReSpeaker? It would help."),
        kind: "question",
      }),
    ).toBeNull();
  });

  it("leaves a title a person or agent set alone", () => {
    expect(
      planRetitle({ title: "Troubleshoot the orchestrator startup hang", body: bodyOf(raw) }),
    ).toBeNull();
    expect(
      planRetitle({ title: "Get T3 orchestrator to troubleshoot this", body: bodyOf(raw) }),
    ).toBeNull();
  });

  it("leaves agent-filed requests, unmarked issues and unquoted bodies alone", () => {
    const title = "Can you get T3 orchestrator to troubleshoot this?";
    expect(planRetitle({ title, body: bodyOf(raw, "agent:thread:1") })).toBeNull();
    expect(planRetitle({ title, body: `> ${title}` })).toBeNull();
    expect(planRetitle({ title, body: null })).toBeNull();
  });

  it("matches only a raw first line or sentence", () => {
    expect(isRawTitle("Hello there", "Hello there. Fix it")).toBe(true);
    expect(isRawTitle("Fix it", "Hello there. Fix it")).toBe(false);
    expect(isRawTitle("", "anything")).toBe(false);
  });
});
