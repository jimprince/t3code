import type {
  ProjectIssueDeferral,
  ProjectIssueOwner,
  ProjectPendingAsk,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import { derivePendingThreadRequests } from "@t3tools/client-runtime/state/thread-requests";

import { resolveWaitingThread } from "./decisions.logic.ts";
import { decisionThreadId } from "./requestLedger.logic.ts";

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const DEADLINE_LINE = /^[\s>*_-]*deadline\s*:\s*(.+?)\s*$/im;
const ISO_DEADLINE =
  /(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::\d{2})?\s*(Z|[+-]\d{2}(?::?\d{2})?)?)?(?!\d)/;
const NAMED_DEADLINE =
  /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?!\d)(?:st|nd|rd|th)?(?:,?\s+(\d{4})(?!\d))?/i;
const DAY_MS = 86_400_000;

const pad = (value: number) => String(value).padStart(2, "0");

/** Whether year-month-day is a real calendar date (31 Feb rolls into March: not one). */
const isCalendarDate = (year: number, month: number, day: number) => {
  const at = DateTime.makeUnsafe(Date.UTC(year, month - 1, day));
  return DateTime.getPartUtc(at, "month") === month && DateTime.getPartUtc(at, "day") === day;
};

/**
 * The decision context's `deadline:` line: a date (`2026-10-08`, `Oct 8`, `October 8, 2026`)
 * or an instant (`2026-10-08 17:00`, UTC unless it carries an offset). A date with no year
 * is the next one on or after the day before the issue was filed. Returns a date
 * (`YYYY-MM-DD`) or an ISO instant, or null when there is no line or it names no real date.
 */
export function parseDecisionDeadline(context: string, createdAt: string): string | null {
  const value = DEADLINE_LINE.exec(context)?.[1];
  if (!value) return null;
  const iso = ISO_DEADLINE.exec(value);
  if (iso) {
    const [, year, month, day, hour, minute, zone] = iso;
    if (!isCalendarDate(Number(year), Number(month), Number(day))) return null;
    const date = `${year}-${month}-${day}`;
    if (hour === undefined) return date;
    const offset =
      zone === undefined || zone === "Z"
        ? "Z"
        : `${zone.slice(0, 3)}:${zone.length > 3 ? zone.slice(-2) : "00"}`;
    return Option.match(DateTime.make(`${date}T${hour}:${minute}:00${offset}`), {
      onNone: () => null,
      onSome: DateTime.formatIso,
    });
  }
  const named = NAMED_DEADLINE.exec(value);
  if (!named) return null;
  const month = MONTHS.indexOf(named[1]!.toLowerCase());
  const day = Number(named[2]);
  const created = Date.parse(createdAt);
  if (named[3] === undefined && Number.isNaN(created)) return null;
  let year =
    named[3] === undefined
      ? DateTime.getPartUtc(DateTime.makeUnsafe(created), "year")
      : Number(named[3]);
  if (named[3] === undefined && Date.UTC(year, month, day) < created - DAY_MS) year += 1;
  if (!isCalendarDate(year, month + 1, day)) return null;
  return `${year}-${pad(month + 1)}-${pad(day)}`;
}

const DEFERRAL_MARKER = /<!--\s*t3-deferral\s+(\{[^}]*\})\s*-->\s*/;

const validInstant = (value: unknown): string | null =>
  typeof value === "string" && !Number.isNaN(Date.parse(value)) ? value : null;

/** The Later state recorded in an issue body, or null when none (or an unreadable one). */
export function parseDeferral(body: string | null | undefined): ProjectIssueDeferral | null {
  const match = DEFERRAL_MARKER.exec(body ?? "");
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[1]!) as { until?: unknown; movedToEndAt?: unknown };
    const until = validInstant(parsed.until);
    const movedToEndAt = validInstant(parsed.movedToEndAt);
    return until === null && movedToEndAt === null ? null : { until, movedToEndAt };
  } catch {
    return null;
  }
}

export type DeferralChange =
  | { readonly mode: "until"; readonly until: string }
  | { readonly mode: "end"; readonly now: string }
  | { readonly mode: "clear" };

/**
 * The issue body with the Later state changed. The state is one hidden comment on its
 * own last line, which the decision parser already ignores; `until` and `end` change
 * their own half and keep the other, `clear` removes the line.
 */
export function applyDeferral(
  body: string | null | undefined,
  change: DeferralChange,
): { readonly body: string; readonly deferral: ProjectIssueDeferral | null } {
  const text = body ?? "";
  const current = parseDeferral(text);
  const next: ProjectIssueDeferral | null =
    change.mode === "clear"
      ? null
      : change.mode === "until"
        ? { until: change.until, movedToEndAt: current?.movedToEndAt ?? null }
        : { until: current?.until ?? null, movedToEndAt: change.now };
  const stripped = text.replace(DEFERRAL_MARKER, "").trimEnd();
  if (next === null) return { body: stripped, deferral: null };
  return {
    body: `${stripped}\n\n<!-- t3-deferral ${JSON.stringify(next)} -->`,
    deferral: next,
  };
}

interface OwnerThread {
  readonly id: string;
  readonly title: string;
  readonly projectId: string;
  readonly updatedAt: string;
  readonly archivedAt: string | null;
  readonly parentThreadId?: string | null | undefined;
}

/**
 * Who a card is for. A `needs-brad` decision goes to the thread its `waiting:` line
 * names. Anything else goes to the live worker linked to the issue; when every linked
 * worker is archived (or none is linked) the project's orchestrator stands in, and
 * the archived worker's title is kept for the card.
 */
export function ownerOfIssue(input: {
  readonly waiting: string | null;
  readonly linkedThreadIds: ReadonlyArray<string>;
  readonly rootThreadId: string;
  readonly threads: ReadonlyArray<OwnerThread>;
  readonly projects: ReadonlyArray<{
    readonly id: string;
    readonly title: string;
    readonly permanentAgent?: { readonly name: string } | null | undefined;
  }>;
}): ProjectIssueOwner | null {
  const { threads, rootThreadId } = input;
  const live = new Set(threads.filter((thread) => thread.archivedAt === null).map((t) => t.id));
  const waitingId =
    input.waiting === null ? null : resolveWaitingThread(input.waiting, threads, input.projects);
  const ownerId = waitingId ?? decisionThreadId(input.linkedThreadIds, rootThreadId, live);
  const owner = threads.find((thread) => thread.id === ownerId);
  if (!owner) return null;
  const gone =
    input.waiting === null && owner.id === rootThreadId
      ? threads.find(
          (thread) =>
            thread.id !== rootThreadId &&
            thread.archivedAt !== null &&
            input.linkedThreadIds.includes(thread.id),
        )
      : undefined;
  return {
    threadId: owner.id as ThreadId,
    title: owner.title,
    projectTitle: input.projects.find((project) => project.id === owner.projectId)?.title ?? "",
    ...(gone ? { previousTitle: gone.title } : {}),
  };
}

interface PullRequestCandidate {
  readonly number: number;
  readonly title: string;
  readonly body?: string | null | undefined;
}

/**
 * The pull requests that close or fix an issue ("Closes #133", "Fixes owner/repo#133")
 * in the issue's own repository; a reference to another repository's #133 is not it.
 */
export function pullRequestsClosing<T extends PullRequestCandidate>(
  pullRequests: ReadonlyArray<T>,
  issueNumber: number,
  repository: string,
): T[] {
  const closing = new RegExp(
    `\\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\\s*:?\\s+(?:${repository.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})?#${issueNumber}(?!\\d)`,
    "i",
  );
  return pullRequests.filter((pr) => closing.test(`${pr.title}\n${pr.body ?? ""}`));
}

/**
 * Why a pull request cannot be merged from a card, or null when it can: only an open,
 * non-draft pull request that the host says is mergeable. An unknown answer waits
 * rather than guessing.
 */
export function mergeBlocker(pr: {
  readonly number: number;
  readonly state: string;
  readonly merged?: boolean | undefined;
  readonly draft?: boolean | undefined;
  readonly mergeable?: boolean | null | undefined;
  readonly base?: string | undefined;
}): string | null {
  if (pr.merged === true) return `PR ${pr.number} is already merged.`;
  if (pr.state !== "open") return `PR ${pr.number} is closed.`;
  if (pr.draft === true) return `PR ${pr.number} is a draft.`;
  if (pr.mergeable === false) {
    // Gitea says false while it is still checking as well as for a conflict.
    return `PR ${pr.number} is not mergeable into ${pr.base ?? "its base branch"}: it conflicts, or Gitea is still checking it. Try again in a moment, or send it back to be rebased.`;
  }
  if (pr.mergeable !== true) {
    return `Gitea has not said whether PR ${pr.number} can merge yet. Try again in a moment.`;
  }
  return null;
}

export interface SendBackPlan {
  /** Posted on the issue. */
  readonly comment: string;
  /** Sent to the thread that owns it. */
  readonly message: string;
}

/** What sending a card back says on the issue and to its owner. */
export function planSendBack(input: {
  readonly note: string;
  readonly title: string;
  readonly reference: string;
  readonly url: string;
}): SendBackPlan | null {
  const note = input.note.trim().replace(/[ \t]+\n/g, "\n");
  if (!note) return null;
  const comment = `Brad sent this back:\n\n${note}`;
  return {
    comment,
    message: `${comment}\n\nOn ${input.reference} "${input.title}" (${input.url}). Do the work again and mark it for review when it is ready.`,
  };
}

/**
 * The pending questions and approvals of one thread, as feed cards. Requests whose text
 * did not survive (no timeline item) are left out, as the thread view leaves them out.
 */
export function pendingAsksOfThread(
  thread: { readonly id: ThreadId; readonly title: string; readonly projectTitle: string },
  projection: Parameters<typeof derivePendingThreadRequests>[0],
): ProjectPendingAsk[] {
  const base = (request: { requestId: ProjectPendingAsk["requestId"]; createdAt: string }) => ({
    threadId: thread.id,
    threadTitle: thread.title,
    projectTitle: thread.projectTitle,
    requestId: request.requestId,
    createdAt: request.createdAt,
  });
  const { approvals, userInputs } = derivePendingThreadRequests(projection);
  return [
    ...userInputs.map((input): ProjectPendingAsk => ({
      ...base(input),
      kind: "question",
      questions: input.questions,
      messageResponse: input.responseMode === "message",
    })),
    ...approvals.map((approval): ProjectPendingAsk => ({
      ...base(approval),
      kind: "approval",
      requestKind: approval.requestKind,
      ...(approval.detail === undefined ? {} : { detail: approval.detail }),
      ...(approval.appName === undefined ? {} : { appName: approval.appName }),
      ...(approval.options === undefined ? {} : { options: approval.options }),
    })),
  ].toSorted((a, b) => a.createdAt.localeCompare(b.createdAt));
}
