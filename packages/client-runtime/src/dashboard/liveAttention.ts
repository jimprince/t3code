/**
 * Which runtime asks (a thread's question or approval) are still pending, read from the thread
 * shells a client already receives live. A Dashboard snapshot can be minutes behind or come from a
 * stored copy, so it must never be what says a thread is still waiting (#303).
 */
export interface LiveRuntimeRequests {
  /** Environments whose shells have loaded; an ask in any other one cannot be judged yet. */
  readonly environments: ReadonlySet<string>;
  /** `runtimeRequestKey` of every pending request on a live thread. */
  readonly pending: ReadonlySet<string>;
}

export const runtimeRequestKey = (environmentId: string, threadId: string, requestId: string) =>
  `${environmentId}|${threadId}|${requestId}`;

interface ThreadLike {
  readonly id: string;
  readonly archivedAt: unknown;
  readonly pendingRuntimeRequest: { readonly id: string } | null;
}

/** From each environment's loaded shell snapshot (null while it has not loaded). */
export function liveRuntimeRequests(
  snapshots: ReadonlyArray<{
    readonly environmentId: string;
    readonly threads: ReadonlyArray<ThreadLike> | null;
  }>,
): LiveRuntimeRequests {
  const environments = new Set<string>();
  const pending = new Set<string>();
  for (const { environmentId, threads } of snapshots) {
    if (threads === null) continue;
    environments.add(environmentId);
    for (const thread of threads)
      if (thread.archivedAt === null && thread.pendingRuntimeRequest)
        pending.add(runtimeRequestKey(environmentId, thread.id, thread.pendingRuntimeRequest.id));
  }
  return { environments, pending };
}

/**
 * The attention items worth showing: issue items always, a runtime ask only while its thread still
 * lists that request as pending. A snapshot stored on this device (`cached`) carries no runtime
 * asks at all, and an environment whose shells have not loaded keeps the live snapshot's asks until
 * they do. Returns the same array when nothing is dropped.
 */
export function liveAttention<
  A extends { readonly requestId: string | null; readonly threadId: string | null },
>(
  environmentId: string,
  attention: ReadonlyArray<A>,
  live: LiveRuntimeRequests,
  source: "cached" | "live" | "empty",
): ReadonlyArray<A> {
  const kept = attention.filter((item) => {
    if (item.requestId === null) return true;
    if (source !== "live") return false;
    if (!live.environments.has(environmentId)) return true;
    return (
      item.threadId !== null &&
      live.pending.has(runtimeRequestKey(environmentId, item.threadId, item.requestId))
    );
  });
  return kept.length === attention.length ? attention : kept;
}
