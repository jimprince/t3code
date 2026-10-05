import type { ProjectIssueDecision } from "@t3tools/contracts";

export const NEEDS_BRAD_LABEL = "needs-brad";
const DEFAULT_WAITING = "chief-of-staff-inbox";

const DECISION_BLOCK = /```decision[ \t]*\r?\n([\s\S]*?)```/;
const MAX_OPTIONS = 5;

/**
 * The decision an issue body asks for, in the fixed format: context first, then one
 * fenced `decision` block with an optional `waiting:` and `options:` list, one option
 * marked `[recommended]`. A body without a block is an open question whose context is
 * the whole body.
 */
export function parseDecisionIssue(body: string | null | undefined): ProjectIssueDecision {
  const text = (body ?? "").replace(/<!--[\s\S]*?-->/g, "");
  const match = DECISION_BLOCK.exec(text);
  const context = (match ? text.slice(0, match.index) : text).trim();
  let waiting = DEFAULT_WAITING;
  const options: Array<{ text: string; recommended: boolean }> = [];
  let inOptions = false;
  for (const raw of (match?.[1] ?? "").split("\n")) {
    const line = raw.trim();
    const key = /^(waiting|options)\s*:\s*(.*)$/i.exec(line);
    if (key) {
      inOptions = key[1]!.toLowerCase() === "options";
      if (!inOptions && key[2]!.trim()) waiting = key[2]!.trim();
      continue;
    }
    const option = inOptions ? /^[-*]\s+(.+)$/.exec(line) : null;
    if (!option) continue;
    const recommended = /\s*\[recommended\]\s*$/i.test(option[1]!);
    const label = option[1]!.replace(/\s*\[recommended\]\s*$/i, "").trim();
    if (label && options.length < MAX_OPTIONS) options.push({ text: label, recommended });
  }
  // Fewer than two options is not a choice: show the open question instead.
  const choices = options.length >= 2 ? options : [];
  const firstRecommended = choices.findIndex((option) => option.recommended);
  return {
    context,
    waiting,
    options: choices.map((option, index) => ({
      text: option.text,
      recommended: index === firstRecommended,
    })),
  };
}

export interface BradAnswerPlan {
  /** Posted on the issue. */
  readonly comment: string;
  /** Sent to the waiting thread. */
  readonly message: string;
}

/**
 * What answering a needs-brad decision does: `Brad chose: <option>` or `Brad answered:
 * <text>` (plus the note) on the issue, and the same answer, with the issue's
 * reference, to the waiting thread. Null when there is nothing to answer with.
 */
export function planBradAnswer(input: {
  readonly decision: "option" | "answer";
  readonly option?: string | undefined;
  readonly answer?: string | undefined;
  readonly note?: string | undefined;
  readonly title: string;
  readonly reference: string;
  readonly url: string;
}): BradAnswerPlan | null {
  const squash = (value: string | undefined) => value?.trim().replace(/\s+/g, " ") ?? "";
  const given = squash(input.decision === "option" ? input.option : input.answer);
  if (!given) return null;
  const note = squash(input.note);
  const headline = input.decision === "option" ? `Brad chose: ${given}` : `Brad answered: ${given}`;
  const comment = note ? `${headline}\n\n${note}` : headline;
  return {
    comment,
    message: `${comment}\n\nOn ${input.reference} "${input.title}" (${input.url}).`,
  };
}

interface WaitingThread {
  readonly id: string;
  readonly title: string;
  readonly projectId: string;
  readonly updatedAt: string;
  readonly archivedAt: string | null;
  readonly parentThreadId?: string | null | undefined;
}

interface WaitingProject {
  readonly id: string;
  readonly permanentAgent?: { readonly name: string } | null | undefined;
}

const slug = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

/**
 * The thread a `waiting:` value names, among the server's live threads: a thread id,
 * a permanent agent's name (its newest live top-level thread), or a thread title in
 * slug form ("chief-of-staff-inbox" is "Chief of Staff inbox"). Saved agent names live
 * in the CLI's own state, so titles are how a name reaches this server.
 */
export function resolveWaitingThread(
  waiting: string,
  threads: ReadonlyArray<WaitingThread>,
  projects: ReadonlyArray<WaitingProject>,
): string | null {
  const wanted = waiting.trim();
  if (!wanted) return null;
  const live = threads.filter((thread) => thread.archivedAt === null);
  const newest = (candidates: ReadonlyArray<WaitingThread>) =>
    candidates.toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0]?.id ?? null;
  const byId = live.find((thread) => thread.id === wanted);
  if (byId) return byId.id;
  const agent = projects.find((project) => project.permanentAgent?.name === wanted);
  if (agent) {
    const incarnation = newest(
      live.filter((thread) => thread.projectId === agent.id && !thread.parentThreadId),
    );
    if (incarnation) return incarnation;
  }
  const wantedSlug = slug(wanted);
  return wantedSlug ? newest(live.filter((thread) => slug(thread.title) === wantedSlug)) : null;
}
