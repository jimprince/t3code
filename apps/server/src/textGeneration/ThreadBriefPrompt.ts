/**
 * Brief me: what an orchestrator thread did since the user last spoke.
 *
 * The transcript is everything after the user's last typed message: worker
 * notices and sends (messages that carry an origin), the orchestrator's replies,
 * and approval or question requests. It is bounded from the newest end, so a long
 * quiet stretch still briefs on what happened most recently.
 */
import * as Schema from "effect/Schema";
import type { OrchestrationThread } from "@t3tools/contracts";
import { readMessageOrigin } from "@t3tools/shared/messageOrigin";

const ENTRY_MAX_CHARS = 700;
const TRANSCRIPT_MAX_CHARS = 24_000;
const REQUEST_ACTIVITY_KINDS = new Set(["approval.requested", "user-input.requested"]);

export interface ThreadBriefTranscript {
  /** Worker-started turns since the user's last message. */
  readonly turnCount: number;
  readonly lines: ReadonlyArray<string>;
}

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

export function collectThreadBriefTranscript(
  thread: Pick<OrchestrationThread, "messages" | "activities">,
): ThreadBriefTranscript {
  const lastPersonIndex = thread.messages.findLastIndex(
    (message) => message.role === "user" && readMessageOrigin(message) === null,
  );
  const since = lastPersonIndex >= 0 ? thread.messages[lastPersonIndex]!.createdAt : null;
  const entries: Array<{ readonly at: string; readonly line: string }> = [];
  let turnCount = 0;
  for (const message of thread.messages.slice(lastPersonIndex + 1)) {
    if (message.role === "user") {
      const origin = readMessageOrigin(message);
      if (origin === null) continue;
      turnCount += 1;
      const from = origin.fromName ?? origin.fromThreadId ?? "a worker";
      entries.push({
        at: message.createdAt,
        line: `[${message.createdAt}] from ${from}: ${clip(message.text, ENTRY_MAX_CHARS)}`,
      });
    } else if (message.role === "assistant" && message.text.trim().length > 0) {
      entries.push({
        at: message.createdAt,
        line: `[${message.createdAt}] orchestrator: ${clip(message.text, ENTRY_MAX_CHARS)}`,
      });
    }
  }
  for (const activity of thread.activities) {
    if (!REQUEST_ACTIVITY_KINDS.has(activity.kind)) continue;
    if (since !== null && activity.createdAt <= since) continue;
    entries.push({
      at: activity.createdAt,
      line: `[${activity.createdAt}] request to the user: ${clip(activity.summary, ENTRY_MAX_CHARS)}`,
    });
  }
  entries.sort((left, right) => left.at.localeCompare(right.at));

  const lines: string[] = [];
  let total = 0;
  for (const entry of entries.toReversed()) {
    total += entry.line.length + 1;
    if (total > TRANSCRIPT_MAX_CHARS) break;
    lines.unshift(entry.line);
  }
  return { turnCount, lines };
}

export const ThreadBriefOutput = Schema.Struct({
  needsYou: Schema.Array(Schema.String),
  done: Schema.Array(Schema.String),
  moving: Schema.Array(Schema.String),
  blocked: Schema.Array(Schema.String),
});
export type ThreadBriefOutput = typeof ThreadBriefOutput.Type;

export function buildThreadBriefPrompt(input: {
  readonly threadTitle: string;
  readonly transcript: ThreadBriefTranscript;
}) {
  const prompt = [
    "You brief a busy person on what their orchestrating agent did while they were away.",
    `The orchestrator thread is titled "${input.threadTitle}".`,
    "Below is everything since the person's last message: notices and results from worker agents, the orchestrator's replies, and requests addressed to the person.",
    "",
    "Return a JSON object with keys needsYou, done, moving and blocked, each an array of short strings.",
    "Rules:",
    "- needsYou: decisions, approvals, questions or results the person must act on. Put these first and never drop one.",
    "- done: work that finished. moving: work still in progress, with its expected next step if stated. blocked: work that cannot proceed and why.",
    "- One line per item, at most 15 words, naming the worker when known. Plain text, no markdown.",
    "- Leave an array empty rather than inventing items. Do not repeat an item across arrays.",
    "",
    "Transcript:",
    ...input.transcript.lines,
  ].join("\n");
  return { prompt, outputSchema: ThreadBriefOutput };
}
