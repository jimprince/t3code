import { normalizeRequestKind, type ProjectIssue, type ThreadId } from "@t3tools/contracts";

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
  readonly items: ReadonlyArray<{
    title: string;
    kind: RequestKind;
    /** A task tagged `bug`. */
    bug?: boolean;
    excerpt: string;
    /** Saved for later: filed with the parked label, off the active request list. */
    parked?: boolean;
    /** The open issue this item continues, when the split named one. */
    existing?: number | null;
  }> | null;
  /**
   * Sent from the New request box: Brad asked for a tracked request, so every
   * item is filed. Ordinary chat messages attach to existing issues instead.
   */
  readonly explicit?: boolean;
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
      ? { version: 1, entries: value.entries.map(normalizeEntryKinds) }
      : EMPTY_OUTBOX;
  } catch {
    return EMPTY_OUTBOX;
  }
}

/** Entries written before the three item types carry an earlier kind; read it as its current one. */
function normalizeEntryKinds(entry: OutboxEntry): OutboxEntry {
  if (!entry.items) return entry;
  return {
    ...entry,
    items: entry.items.map((item) => {
      const kind = normalizeRequestKind(item.kind);
      const bug = item.bug || (item.kind as string) === "bug";
      return { ...item, kind, ...(bug ? { bug: true } : {}) };
    }),
  };
}

/**
 * Adds a captured message unless the same message is already queued. An explicit
 * entry (the New request box) upgrades a capture of the same message that has
 * not been split yet, whichever arrived first.
 */
export function enqueue(outbox: Outbox, entry: OutboxEntry): Outbox {
  const existing = outbox.entries.find((candidate) => candidate.messageId === entry.messageId);
  if (!existing) return { ...outbox, entries: [...outbox.entries, entry] };
  if (!entry.explicit || existing.explicit || existing.items !== null) return outbox;
  return updateEntry(outbox, entry.messageId, (current) => ({ ...current, explicit: true }));
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
