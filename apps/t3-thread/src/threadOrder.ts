import type { OrchestrationThreadShell } from "./types.js";

export type ThreadOrderSection = "pinned" | "active";
export type OrderableThread = Pick<
  OrchestrationThreadShell,
  | "id"
  | "parentThreadId"
  | "remoteParent"
  | "pinnedAt"
  | "pinOrderKey"
  | "activeOrderKey"
  | "createdAt"
  | "unsettledAt"
  | "archivedAt"
  | "settledOverride"
>;

const ORDER_DIGITS = "abcdefghijklmnopqrstuvwxyz";

function spreadOrderKeys(count: number): string[] {
  let width = 2;
  let space = ORDER_DIGITS.length ** width;
  while (space <= (count + 1) * 2) {
    width += 1;
    space *= ORDER_DIGITS.length;
  }
  const step = space / (count + 1);
  return Array.from({ length: count }, (_, index) => {
    let value = Math.round(step * (index + 1));
    if (value % ORDER_DIGITS.length === 0) value += 1;
    let key = "";
    for (let digit = 0; digit < width; digit += 1) {
      key = ORDER_DIGITS.charAt(value % ORDER_DIGITS.length) + key;
      value = Math.floor(value / ORDER_DIGITS.length);
    }
    return key;
  });
}

export function threadOrderSection(thread: OrderableThread): ThreadOrderSection | null {
  if (thread.archivedAt !== null) return null;
  if (thread.pinnedAt != null) return "pinned";
  return thread.settledOverride === "settled" ? null : "active";
}

export function sameThreadOrderGroup(left: OrderableThread, right: OrderableThread): boolean {
  return (
    threadOrderSection(left) === threadOrderSection(right) &&
    threadOrderSection(left) !== null &&
    (left.parentThreadId ?? null) === (right.parentThreadId ?? null) &&
    (left.remoteParent?.environmentId ?? null) === (right.remoteParent?.environmentId ?? null) &&
    (left.remoteParent?.threadId ?? null) === (right.remoteParent?.threadId ?? null)
  );
}

function automaticTimestamp(thread: OrderableThread): number {
  return Math.max(Date.parse(thread.createdAt) || 0, Date.parse(thread.unsettledAt ?? "") || 0);
}

export function sortThreadOrderGroup(threads: readonly OrderableThread[]): OrderableThread[] {
  const section = threads[0] ? threadOrderSection(threads[0]) : null;
  return [...threads].sort((left, right) => {
    const leftKey = section === "pinned" ? left.pinOrderKey : left.activeOrderKey;
    const rightKey = section === "pinned" ? right.pinOrderKey : right.activeOrderKey;
    if (section === "pinned") {
      if (leftKey != null && rightKey == null) return -1;
      if (leftKey == null && rightKey != null) return 1;
    } else {
      if (leftKey == null && rightKey != null) return -1;
      if (leftKey != null && rightKey == null) return 1;
    }
    if (leftKey != null && rightKey != null && leftKey !== rightKey) {
      return leftKey < rightKey ? -1 : 1;
    }
    return automaticTimestamp(right) - automaticTimestamp(left) || left.id.localeCompare(right.id);
  });
}

export function planExplicitThreadOrder(input: {
  readonly group: readonly OrderableThread[];
  readonly leadingIds: readonly string[];
}): ReadonlyArray<{ readonly threadId: string; readonly orderKey: string }> {
  const current = sortThreadOrderGroup(input.group);
  const unique = new Set(input.leadingIds);
  if (unique.size !== input.leadingIds.length) throw new Error("Thread order contains duplicates.");
  const byId = new Map(current.map((thread) => [thread.id, thread]));
  for (const id of input.leadingIds) {
    if (!byId.has(id)) throw new Error(`Thread '${id}' is not in this sidebar section.`);
  }
  const desired = [
    ...input.leadingIds.map((id) => byId.get(id)!),
    ...current.filter((thread) => !unique.has(thread.id)),
  ];
  const keys = spreadOrderKeys(desired.length);
  return desired.flatMap((thread, index) => {
    const currentKey =
      threadOrderSection(thread) === "pinned" ? thread.pinOrderKey : thread.activeOrderKey;
    return currentKey === keys[index] ? [] : [{ threadId: thread.id, orderKey: keys[index]! }];
  });
}

export function planThreadMove(input: {
  readonly group: readonly OrderableThread[];
  readonly threadId: string;
  readonly beforeId?: string;
  readonly afterId?: string;
  readonly edge?: "top" | "bottom";
}): ReadonlyArray<{ readonly threadId: string; readonly orderKey: string }> {
  const ordered = sortThreadOrderGroup(input.group);
  const moved = ordered.find((thread) => thread.id === input.threadId);
  if (!moved) throw new Error(`Thread '${input.threadId}' is not in this sidebar section.`);
  const remainder = ordered.filter((thread) => thread.id !== input.threadId);
  let index: number;
  if (input.edge === "top") index = 0;
  else if (input.edge === "bottom") index = remainder.length;
  else {
    const targetId = input.beforeId ?? input.afterId;
    const targetIndex = remainder.findIndex((thread) => thread.id === targetId);
    if (targetIndex < 0) throw new Error(`Target thread '${targetId}' is not a sibling.`);
    index = targetIndex + (input.afterId ? 1 : 0);
  }
  remainder.splice(index, 0, moved);
  return planExplicitThreadOrder({
    group: ordered,
    leadingIds: remainder.map((thread) => thread.id),
  });
}
