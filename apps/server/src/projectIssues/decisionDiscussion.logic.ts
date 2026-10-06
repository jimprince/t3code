import type { ProjectIssueDecision } from "@t3tools/contracts";

const TITLE_CHARS = 80;

/**
 * A decision's discussion thread is titled `Discuss #N: <question>`. The prefix is how
 * a second Discuss on the same decision finds the first one instead of opening another.
 */
export function discussionTitle(number: number, question: string): string {
  const title = `Discuss #${number}: ${question.trim().replace(/\s+/g, " ")}`;
  return title.length > TITLE_CHARS ? `${title.slice(0, TITLE_CHARS - 3).trimEnd()}...` : title;
}

interface DiscussionCandidate {
  readonly id: string;
  readonly title: string;
  readonly archivedAt: string | null;
  readonly parentThreadId?: string | null | undefined;
}

/** The live discussion of decision #N already nested under its owner, if any. */
export function findDiscussion(
  threads: ReadonlyArray<DiscussionCandidate>,
  ownerThreadId: string,
  number: number,
): string | null {
  const prefix = `Discuss #${number}:`;
  return (
    threads.find(
      (thread) =>
        thread.archivedAt === null &&
        thread.parentThreadId === ownerThreadId &&
        thread.title.startsWith(prefix),
    )?.id ?? null
  );
}

/**
 * What the decision asks, as the discussion sees it: a needs-brad issue's parsed
 * decision block, or a Needs you item's latest comment (a plan to approve, or
 * options listed as "Option A:" lines), which is answered with approve, an option
 * or not yet.
 */
export type DiscussedDecision =
  | { readonly kind: "needs-brad"; readonly decision: ProjectIssueDecision }
  | { readonly kind: "needs-you"; readonly comment: string };

/**
 * The first message of a decision's discussion thread: the question, its context and
 * options, and the one command that records Brad's answer exactly as the Decisions
 * widget would (comment, label, message to the waiting thread).
 */
export function buildDiscussionBrief(input: {
  readonly title: string;
  readonly url: string;
  /** `owner/repo#N`. */
  readonly reference: string;
  readonly decided: DiscussedDecision;
  /** A thread of the decision's project, for the answer command. */
  readonly projectThreadId: string;
  readonly owner: { readonly id: string; readonly title: string };
}): string {
  const answer = `t3-thread decision answer ${input.projectThreadId} ${input.reference}`;
  const lines = [
    `Brad wants to talk through this decision before answering it. You are nested under "${input.owner.title}" (thread ${input.owner.id}), which is waiting on his answer.`,
    "",
    `Question: ${input.title}`,
    `Issue: ${input.url}`,
  ];
  if (input.decided.kind === "needs-brad") {
    const { decision } = input.decided;
    if (decision.context) lines.push("", decision.context);
    if (decision.options.length > 0) {
      lines.push("", "Options:");
      for (const option of decision.options) {
        lines.push(`- ${option.text}${option.recommended ? " (recommended)" : ""}`);
      }
    }
    lines.push(
      "",
      "Discuss it with Brad: answer his questions, look things up when that helps, and do not start the work itself. When he settles on an answer, record it once:",
      ...(decision.options.length > 0
        ? [`  ${answer} --option "<the option exactly as listed>" [--note "<one line of why>"]`]
        : []),
      `  ${answer} --answer "<his answer in his words>" [--note "<one line of why>"]`,
    );
  } else {
    if (input.decided.comment.trim()) {
      lines.push("", "Latest comment:", input.decided.comment.trim());
    }
    lines.push(
      "",
      "Discuss it with Brad: answer his questions, look things up when that helps, and do not start the work itself. When he settles, record it once:",
      `  ${answer} --approve`,
      `  ${answer} --option "<the option as listed, e.g. A: ...>"`,
      `  ${answer} --not-yet [--note "<his reason>"]`,
      `If he wants something none of these say, send it to the waiting thread instead: t3-thread send ${input.owner.id} "<his answer on ${input.reference}>".`,
    );
  }
  lines.push(
    "",
    'Recording it comments the answer on the issue and tells the waiting thread, exactly like answering from the Decisions widget. (The decision_answer MCP tool does the same.) Then stop: settle yourself with `t3-thread settle "$T3_THREAD_ID" --self` and end with one line saying what Brad chose.',
  );
  return lines.join("\n");
}
