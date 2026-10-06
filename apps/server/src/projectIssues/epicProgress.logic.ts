import type { ProjectEpicProgress } from "@t3tools/contracts";

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
  const items: Array<{ number: number; checked: boolean }> = [];
  for (const match of (body ?? "").matchAll(/^[ \t]*[-*][ \t]+\[([ xX])\][ \t]+#(\d+)\b/gm)) {
    items.push({ number: Number(match[2]), checked: match[1] !== " " });
  }
  return items;
}

/** The epic a child issue belongs to: its body starts "Part of #N". */
export function parsePartOf(body: string | null | undefined): number | null {
  const match = /^\s*part of #(\d+)\b/i.exec(body ?? "");
  return match ? Number(match[1]) : null;
}

/**
 * Progress of every epic in one repository's issues. Children are the checklist
 * refs plus the issues that say "Part of #N"; a child is done when it is closed
 * or ticked. A child outside the list (closed long ago, or elsewhere) counts only
 * through its tick.
 */
export function epicProgress(
  issues: ReadonlyArray<EpicSourceIssue>,
): Map<number, ProjectEpicProgress> {
  const byNumber = new Map(issues.map((issue) => [issue.number, issue]));
  const partOf = new Map<number, number[]>();
  for (const issue of issues) {
    const parent = parsePartOf(issue.body);
    if (parent !== null && parent !== issue.number) {
      partOf.set(parent, [...(partOf.get(parent) ?? []), issue.number]);
    }
  }
  const result = new Map<number, ProjectEpicProgress>();
  for (const epic of issues) {
    if (!isEpic(epic.labels)) continue;
    const children = new Map<number, boolean>();
    for (const item of parseEpicChecklist(epic.body)) {
      if (item.number !== epic.number) children.set(item.number, item.checked);
    }
    for (const number of partOf.get(epic.number) ?? []) {
      if (!children.has(number)) children.set(number, false);
    }
    const remaining: number[] = [];
    let done = 0;
    for (const [number, checked] of children) {
      if (checked || byNumber.get(number)?.closed) done += 1;
      else remaining.push(number);
    }
    result.set(epic.number, { done, total: children.size, remaining });
  }
  return result;
}
