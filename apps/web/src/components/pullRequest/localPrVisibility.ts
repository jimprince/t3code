import * as Schema from "effect/Schema";
import { useMemo, useState } from "react";
import type { EnvironmentId } from "@t3tools/contracts";
import { pullRequestEntryKey, type EnvironmentPullRequestEntry } from "./pullRequestList.logic";

/** A locally removed row is hidden by its environment-qualified identity, never changed upstream. */
export function filterRemovedPullRequests<Entry extends EnvironmentPullRequestEntry>(
  entries: ReadonlyArray<Entry>,
  removedKeys: ReadonlySet<string>,
): ReadonlyArray<Entry> {
  if (removedKeys.size === 0) return entries;
  return entries.filter((entry) => !removedKeys.has(pullRequestEntryKey(entry)));
}

/** Add or remove the rendered rows from a selection without disturbing keys outside that view. */
export function setVisiblePullRequestsSelected(
  selectedKeys: ReadonlySet<string>,
  visibleKeys: ReadonlyArray<string>,
  selected: boolean,
): ReadonlySet<string> {
  const next = new Set(selectedKeys);
  for (const key of visibleKeys) {
    if (selected) next.add(key);
    else next.delete(key);
  }
  return next;
}

const removedPullRequestsStorageKey = (environmentId: string) =>
  `t3.pullRequests.removed:${environmentId}`;
type RemovedPullRequestsStorage = Pick<Storage, "getItem" | "setItem">;
const decodeRemovedPullRequestKeys = Schema.decodeUnknownOption(Schema.Array(Schema.String));

/** Local dismissals are scoped to one environment so one server cannot hide another's rows. */
export function readRemovedPullRequestKeys(
  storage: RemovedPullRequestsStorage | undefined,
  environmentId: string,
): ReadonlySet<string> {
  try {
    const raw = storage?.getItem(removedPullRequestsStorageKey(environmentId));
    if (!raw) return new Set();
    const decoded = decodeRemovedPullRequestKeys(JSON.parse(raw));
    return decoded._tag === "Some" ? new Set(decoded.value) : new Set();
  } catch {
    return new Set();
  }
}

export function writeRemovedPullRequestKeys(
  storage: RemovedPullRequestsStorage | undefined,
  environmentId: string,
  removedKeys: ReadonlySet<string>,
): void {
  try {
    storage?.setItem(
      removedPullRequestsStorageKey(environmentId),
      JSON.stringify([...removedKeys]),
    );
  } catch {
    // Storage can be full or denied; removals still apply for this renderer session.
  }
}

/** New keys include the provider; legacy host/repository keys remain readable in their own environment. */
export function localPullRequestKey(entry: EnvironmentPullRequestEntry): string {
  return JSON.stringify([
    entry.provider,
    entry.host.toLowerCase(),
    entry.repository.toLowerCase(),
    entry.number,
  ]);
}

function browserStorage(): RemovedPullRequestsStorage | undefined {
  try {
    return typeof window === "undefined" ? undefined : window.localStorage;
  } catch {
    return undefined;
  }
}

export function useLocalPrVisibility(environmentIds: ReadonlyArray<EnvironmentId>) {
  const [stored, setStored] = useState<ReadonlyMap<string, ReadonlySet<string>>>(() => new Map());
  const removed = useMemo(
    () =>
      new Map(
        environmentIds.map(
          (id) => [id, stored.get(id) ?? readRemovedPullRequestKeys(browserStorage(), id)] as const,
        ),
      ),
    [environmentIds, stored],
  );
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
  return {
    selected,
    removedCount: [...removed.values()].reduce((count, keys) => count + keys.size, 0),
    filter<Entry extends EnvironmentPullRequestEntry>(
      entries: ReadonlyArray<Entry>,
    ): ReadonlyArray<Entry> {
      return entries.filter((entry) => {
        const keys = removed.get(entry.environmentId);
        return !keys?.has(localPullRequestKey(entry)) && !keys?.has(pullRequestEntryKey(entry));
      });
    },
    select(keys: ReadonlyArray<string>, checked: boolean) {
      setSelected((current) => setVisiblePullRequestsSelected(current, keys, checked));
    },
    dismiss(entries: ReadonlyArray<EnvironmentPullRequestEntry>) {
      setStored((current) => {
        const next = new Map(current);
        for (const id of environmentIds) {
          const keys = new Set(current.get(id) ?? removed.get(id));
          for (const entry of entries) {
            if (entry.environmentId === id && selected.has(pullRequestEntryKey(entry)))
              keys.add(localPullRequestKey(entry));
          }
          writeRemovedPullRequestKeys(browserStorage(), id, keys);
          next.set(id, keys);
        }
        return next;
      });
      setSelected(new Set());
    },
    restore() {
      const next = new Map(stored);
      for (const id of environmentIds) {
        const empty = new Set<string>();
        writeRemovedPullRequestKeys(browserStorage(), id, empty);
        next.set(id, empty);
      }
      setStored(next);
    },
  };
}
