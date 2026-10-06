import type { ProjectIssue, ThreadId } from "@t3tools/contracts";

import type { RequestKind } from "../textGeneration/RequestItemsPrompt.ts";

/**
 * One captured message waiting to be filed. It stays in the server's outbox file
 * until every request split from it exists as an issue, so a message typed while
 * Gitea is unreachable is filed when Gitea returns instead of being lost.
 */
export interface OutboxEntry {
  readonly messageId: string;
  readonly threadId: ThreadId;
  readonly rootThreadId: ThreadId;
  readonly text: string;
  readonly capturedAt: string;
  /** Requests split from the message; null until the split has run. */
  readonly items: ReadonlyArray<{ title: string; kind: RequestKind; excerpt: string }> | null;
  /** Indexes of `items` already filed as issues. */
  readonly filed: ReadonlyArray<number>;
  readonly attempts: number;
  readonly lastError: string | null;
  /** Epoch ms before which the drain skips this entry (retry backoff). */
  readonly nextAttemptAt: number;
}

export interface Outbox {
  readonly version: 1;
  readonly entries: ReadonlyArray<OutboxEntry>;
}

export const EMPTY_OUTBOX: Outbox = { version: 1, entries: [] };

export function parseOutbox(contents: string | null): Outbox {
  if (!contents) return EMPTY_OUTBOX;
  try {
    const value = JSON.parse(contents) as Partial<Outbox>;
    return value?.version === 1 && Array.isArray(value.entries)
      ? { version: 1, entries: value.entries }
      : EMPTY_OUTBOX;
  } catch {
    return EMPTY_OUTBOX;
  }
}

/** Adds a captured message unless the same message is already queued. */
export function enqueue(outbox: Outbox, entry: OutboxEntry): Outbox {
  return outbox.entries.some((existing) => existing.messageId === entry.messageId)
    ? outbox
    : { ...outbox, entries: [...outbox.entries, entry] };
}

export function updateEntry(
  outbox: Outbox,
  messageId: string,
  change: (entry: OutboxEntry) => OutboxEntry | null,
): Outbox {
  const entries: OutboxEntry[] = [];
  for (const entry of outbox.entries) {
    if (entry.messageId !== messageId) {
      entries.push(entry);
      continue;
    }
    const next = change(entry);
    if (next) entries.push(next);
  }
  return { ...outbox, entries };
}

/** Retry backoff: 30 s doubling to a 10 minute ceiling. */
export function retryDelayMs(attempts: number): number {
  return Math.min(10 * 60_000, 30_000 * 2 ** Math.max(0, attempts - 1));
}

/**
 * Whether request `item` of `messageId` already exists, so a retry after a crash
 * or a lost response never files the same request twice.
 */
export function isAlreadyFiled(
  issues: ReadonlyArray<Pick<ProjectIssue, "requestSource">>,
  messageId: string,
  item: number,
): boolean {
  return issues.some(
    (issue) =>
      issue.requestSource?.messageId === messageId && (issue.requestSource.item ?? 0) === item,
  );
}
