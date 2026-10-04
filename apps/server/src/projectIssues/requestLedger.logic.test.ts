import type { ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { parseRequestMarker } from "./projectIssues.logic.ts";
import {
  capturableMessage,
  clampTitle,
  fallbackRequestItem,
  formatRequestIssueBody,
  isObviouslyNotARequest,
} from "./requestLedger.logic.ts";

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
