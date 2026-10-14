// @effect-diagnostics-next-line nodeBuiltinImport:off -- Pure stable identities are computed only at the tracker adapter boundary.
import * as NodeCrypto from "node:crypto";
import * as DateTime from "effect/DateTime";
import type { ProjectIssuePlan } from "@t3tools/contracts";

/** Only source Markdown counts: quoted examples and matching fenced blocks are excluded. */
const TRACKER_BODY_LIMIT = 64 * 1024;
const TRACKER_TEXT_LIMIT = 500;
export const trackerBodyTruncated = (body: string | null | undefined) =>
  (body?.length ?? 0) > TRACKER_BODY_LIMIT;
const shortText = (text: string) =>
  text.length > TRACKER_TEXT_LIMIT ? `${text.slice(0, TRACKER_TEXT_LIMIT - 1)}…` : text;
/** A bounded source prefix never ends in a partial line that could invent a reference. */
export function trackerBodyPrefix(body: string | null | undefined): string {
  const text = body ?? "";
  if (!trackerBodyTruncated(text)) return text;
  const prefix = text.slice(0, TRACKER_BODY_LIMIT);
  return prefix.slice(0, prefix.lastIndexOf("\n") + 1);
}
function trackerContentLines(body: string | null | undefined): string[] {
  const lines: string[] = [];
  let fence: { character: string; length: number } | null = null;
  for (const line of trackerBodyPrefix(body).split(/\r?\n/)) {
    if (!line.trim()) continue;
    if (/^\s*>/.test(line)) continue;
    const marker = /^\s{0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (marker) {
      const run = marker[1]!;
      if (!fence) fence = { character: run[0]!, length: run.length };
      else if (run[0] === fence.character && run.length >= fence.length && !marker[2]!.trim())
        fence = null;
      continue;
    }
    if (!fence) lines.push(line);
  }
  return lines;
}
export function parseTrackerSteps(body: string | null | undefined) {
  return trackerContentLines(body).flatMap((line) => {
    const match = /^\s*[-*+]\s+\[([ xX])\]\s+(\S.*)$/.exec(line);
    return match ? [{ text: shortText(match[2]!.trimEnd()), checked: match[1] !== " " }] : [];
  });
}
export interface TrackerComment {
  readonly id: number;
  readonly body: string;
  readonly createdAt: string;
}
export function latestProgressNote(comments: readonly TrackerComment[]) {
  const note = comments
    .filter((c) => c.body.startsWith("Progress: ") && Number.isFinite(Date.parse(c.createdAt)))
    .toSorted((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || b.id - a.id)[0];
  if (!note) return null;
  const body = note.body.slice(0, TRACKER_BODY_LIMIT);
  const next = /\bnext:[ \t]*([^\r\n]*)/i.exec(body.slice("Progress: ".length));
  return { ...note, body, nextStep: next?.[1]?.trim() ? shortText(next[1].trim()) : null };
}
/** Version represents step identity, independently of ticks, rank, title and attribution. */
export function trackerPlan(input: {
  readonly body: string | null | undefined;
  readonly closed: boolean;
  readonly closedAt: string | null;
  readonly stage?: string | undefined;
  readonly note?: ReturnType<typeof latestProgressNote> | undefined;
  readonly children?: readonly { number: number; done: boolean }[] | undefined;
}): ProjectIssuePlan {
  const steps = parseTrackerSteps(input.body);
  const children = input.children?.toSorted((a, b) => a.number - b.number);
  const done = children
    ? children.filter((c) => c.done).length
    : steps.length
      ? steps.filter((s) => s.checked).length
      : Number(input.closed);
  const total = children ? children.length : steps.length || 1;
  // Hash step identity independently of current completion evidence.
  const planVersion = NodeCrypto.createHash("sha256")
    .update(
      JSON.stringify(
        children
          ? ["children", children.map((c) => c.number)]
          : ["steps", steps.map((s) => s.text)],
      ),
    )
    .digest("hex");
  const evidenceVersion = JSON.stringify([
    planVersion,
    children?.map((c) => c.done) ?? steps.map((s) => s.checked),
    input.stage ?? null,
    input.closed,
  ]);
  return {
    done,
    total,
    hasChecklist: steps.length > 0,
    truncated: trackerBodyTruncated(input.body),
    planVersion,
    evidenceVersion,
    confirmedAt: input.closedAt ?? input.note?.createdAt ?? null,
    nextStep: input.note?.nextStep ?? steps.find((s) => !s.checked)?.text ?? null,
  };
}
/** A first read cannot date a checklist edit. Later observed completion/stage changes can. */
export function confirmTrackerPlan(
  current: ProjectIssuePlan,
  previous: ProjectIssuePlan | null,
  observedAt: string,
): ProjectIssuePlan {
  const changed = previous && current.evidenceVersion !== previous.evidenceVersion;
  const evidence = [current.confirmedAt, previous?.confirmedAt, changed ? observedAt : null]
    .filter((at): at is string => at != null)
    .toSorted((a, b) => Date.parse(a) - Date.parse(b));
  return { ...current, confirmedAt: evidence.at(-1) ?? null };
}
export function trackerDueDate(value: string | null | undefined): string | null {
  if (!value) return null;
  const day = /^\d{4}-\d{2}-\d{2}/.exec(value)?.[0];
  return day &&
    Number.isFinite(Date.parse(day)) &&
    DateTime.formatIso(DateTime.makeUnsafe(day)).slice(0, 10) === day
    ? day
    : null;
}
export function trackerCommentIssueNumber(url: string): number | null {
  const number = Number(/\/issues\/(\d+)$/.exec(url)?.[1]);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}
