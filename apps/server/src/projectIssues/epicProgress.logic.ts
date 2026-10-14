import type { ProjectEpicProgress } from "@t3tools/contracts";
import { parseTrackerSteps, trackerBodyTruncated, trackerBodyPrefix } from "./trackerPlan.logic.ts";

/** The slice of a tracker issue epic progress reads. */
export interface EpicSourceIssue {
  readonly number: number;
  readonly body: string | null | undefined;
  readonly labels: ReadonlyArray<string>;
  readonly closed: boolean;
}

/**
 * An epic is labeled `ask:epic`; an older `ask:plan` reads as one unless a newer
 * `ask:task` or `ask:question` label says otherwise (new labels win).
 */
export function isEpic(labels: ReadonlyArray<string>): boolean {
  const names = new Set(labels.map((label) => label.toLowerCase()));
  if (names.has("ask:epic")) return true;
  return names.has("ask:plan") && !names.has("ask:task") && !names.has("ask:question");
}

/** The `#N` items of an epic body's checklist ("- [ ] #12 title", "- [x] #12"), with their ticks. */
export function parseEpicChecklist(
  body: string | null | undefined,
): Array<{ number: number; checked: boolean }> {
  return parseTrackerSteps(body).flatMap((step) => {
    const match = /^#(\d+)\b/.exec(step.text);
    const number = Number(match?.[1]);
    return Number.isSafeInteger(number) && number > 0 ? [{ number, checked: step.checked }] : [];
  });
}

export const PART_OF_LINE = /^\s*part of #(\d+)\b[^\n]*(?:\r?\n){0,2}/i;

/** The epic a child issue belongs to: its body starts "Part of #N". */
export function membershipContentStart(body: string): number {
  const text = trackerBodyPrefix(body);
  const leading = text.trimStart();
  const start = text.length - leading.length;
  const newline = leading.indexOf("\n");
  const line = leading.slice(0, newline < 0 ? leading.length : newline).trimEnd();
  return /^<!--[ \t]*t3-plan:[^>]+-->$/.test(line)
    ? start + (newline < 0 ? leading.length : newline + 1)
    : 0;
}
function firstMembershipLine(body: string | null | undefined): string {
  const text = trackerBodyPrefix(body);
  const leading = text.slice(membershipContentStart(text)).trimStart();
  const newline = leading.indexOf("\n");
  return leading.slice(0, newline < 0 ? leading.length : newline);
}
export function parsePartOf(body: string | null | undefined): number | null {
  const match = PART_OF_LINE.exec(firstMembershipLine(body));
  const number = Number(match?.[1]);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

/** Resolve primary membership once for both headers and rows; ambiguous checklist parents are reported. */
export function trackerMembership(issues: ReadonlyArray<EpicSourceIssue>) {
  const byNumber = new Map(issues.map((issue) => [issue.number, issue]));
  const parents = new Map<number, number>();
  const warnings = new Map<number, string[]>();
  const warn = (number: number, warning: string) =>
    warnings.set(number, [...new Set([...(warnings.get(number) ?? []), warning])]);
  const ticks = new Map<number, Map<number, boolean>>();
  const candidates = new Map<number, number[]>();
  for (const parent of issues) {
    if (parent.closed) continue;
    const children = new Map<number, boolean>();
    for (const ref of parseEpicChecklist(parent.body)) {
      if (ref.number === parent.number) {
        warn(parent.number, "self-reference");
        continue;
      }
      children.set(ref.number, (children.get(ref.number) ?? false) || ref.checked);
    }
    ticks.set(parent.number, children);
    for (const number of children.keys())
      candidates.set(number, [...(candidates.get(number) ?? []), parent.number]);
  }
  const numbers = new Set([...byNumber.keys(), ...candidates.keys()]);
  for (const number of numbers) {
    const issue = byNumber.get(number);
    const canonical = parsePartOf(issue?.body);
    if (canonical === null && /^\s*part of\b/i.test(firstMembershipLine(issue?.body)))
      warn(number, "malformed-parent");
    const alternatives = candidates.get(number) ?? [];
    if (canonical === number) {
      warn(number, "self-reference");
      continue;
    }
    if (canonical !== null) {
      if (byNumber.has(canonical) && !byNumber.get(canonical)!.closed)
        parents.set(number, canonical);
      else warn(number, "missing-or-closed-parent");
      if (alternatives.some((n) => n !== canonical)) warn(number, "conflicting-checklist-parents");
    } else if (alternatives.length === 1) parents.set(number, alternatives[0]!);
    else if (alternatives.length > 1) warn(number, "conflicting-checklist-parents");
  }
  const cyclic = new Set<number>();
  const visited = new Set<number>();
  for (const number of parents.keys()) {
    const path: number[] = [];
    const offsets = new Map<number, number>();
    let current: number | undefined = number;
    while (current !== undefined && parents.has(current) && !visited.has(current)) {
      const at = offsets.get(current);
      if (at !== undefined) {
        for (const n of path.slice(at)) cyclic.add(n);
        break;
      }
      offsets.set(current, path.length);
      path.push(current);
      current = parents.get(current);
    }
    for (const n of path) visited.add(n);
  }
  for (const number of cyclic) {
    parents.delete(number);
    warn(number, "cyclic-membership");
  }
  const workstreams = new Set(
    issues.filter((issue) => !issue.closed && isEpic(issue.labels)).map((issue) => issue.number),
  );
  for (const parent of parents.values()) workstreams.add(parent);
  const children = new Map<number, Array<{ number: number; done: boolean; unknown: boolean }>>();
  for (const [number, parent] of parents) {
    const issue = byNumber.get(number);
    const steps = parseTrackerSteps(issue?.body);
    const done = Boolean(
      ticks.get(parent)?.get(number) ||
      issue?.closed ||
      (!trackerBodyTruncated(issue?.body) && steps.length > 0 && steps.every((s) => s.checked)),
    );
    const list = children.get(parent) ?? [];
    list.push({ number, done, unknown: !issue && !done });
    children.set(parent, list);
  }
  return { parents, warnings, workstreams, children };
}

/** Unique child completion for open labeled and inferred workstreams. Missing unticked children remain unfinished. */
export function epicProgress(
  issues: ReadonlyArray<EpicSourceIssue>,
  membership = trackerMembership(issues),
): Map<number, ProjectEpicProgress> {
  return new Map(
    [...membership.workstreams].map((number) => {
      const children = membership.children.get(number) ?? [];
      return [
        number,
        {
          done: children.filter((c) => c.done).length,
          total: children.length,
          remaining: children.filter((c) => !c.done).map((c) => c.number),
        },
      ];
    }),
  );
}

/** Briefing roots retain the labelled-epic rule, independently of tracker membership. */
export function parseBriefingPartOf(body: string | null | undefined): number | null {
  const match = PART_OF_LINE.exec(trackerBodyPrefix(body));
  return match ? Number(match[1]) : null;
}
export function briefingEpicProgress(
  issues: ReadonlyArray<EpicSourceIssue>,
): Map<number, ProjectEpicProgress> {
  const byNumber = new Map(issues.map((issue) => [issue.number, issue]));
  const partOf = new Map<number, number[]>();
  for (const issue of issues) {
    const parent = parseBriefingPartOf(issue.body);
    if (parent !== null && parent !== issue.number)
      partOf.set(parent, [...(partOf.get(parent) ?? []), issue.number]);
  }
  const result = new Map<number, ProjectEpicProgress>();
  for (const epic of issues) {
    if (!isEpic(epic.labels)) continue;
    const children = new Map<number, boolean>();
    for (const match of trackerBodyPrefix(epic.body).matchAll(
      /^[ \t]*[-*][ \t]+\[([ xX])\][ \t]+#(\d+)\b/gm,
    )) {
      const number = Number(match[2]);
      if (number !== epic.number) children.set(number, match[1] !== " ");
    }
    for (const number of partOf.get(epic.number) ?? [])
      if (!children.has(number)) children.set(number, false);
    const remaining = [...children]
      .filter(([number, checked]) => !checked && !byNumber.get(number)?.closed)
      .map(([number]) => number);
    result.set(epic.number, {
      done: children.size - remaining.length,
      total: children.size,
      remaining,
    });
  }
  return result;
}
