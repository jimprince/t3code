import type { EnvironmentId, OrchestrationV2ThreadShell, ThreadId } from "@t3tools/contracts";
import { percentDecodedThreadLinkId } from "@t3tools/shared/threadLinks";
import { Atom } from "effect/reactivity";

import type { EnvironmentConnectionSummary } from "./presentation.ts";
import type { EnvironmentShellState } from "./shell.ts";

/** What a link follower knows about one enabled environment. */
export interface ThreadLinkEnvironment<Shell extends { readonly id: ThreadId }> {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  /** The thread list is current (a live shell stream). Only a live list can say a thread is absent. */
  readonly live: boolean;
  /** Not live yet, but on its way: connecting, reconnecting, or connected and still loading its thread list. */
  readonly connecting: boolean;
  readonly threads: ReadonlyMap<ThreadId, Shell>;
}

export type ThreadLinkResolution<Shell extends { readonly id: ThreadId }> =
  | {
      readonly kind: "found";
      readonly environmentId: EnvironmentId;
      readonly label: string;
      /** The id that matched: the one written, or its percent-decoded form. */
      readonly threadId: ThreadId;
      readonly thread: Shell;
      readonly inPreferredEnvironment: boolean;
    }
  | {
      /** Several environments other than the message's own hold this id. */
      readonly kind: "ambiguous";
      readonly threadId: ThreadId;
      readonly candidates: ReadonlyArray<{
        readonly environmentId: EnvironmentId;
        readonly label: string;
      }>;
    }
  | { readonly kind: "unavailable"; readonly reason: "not-found" }
  | {
      readonly kind: "unavailable";
      readonly reason: "disconnected";
      /** Labels of the environments that could not answer. */
      readonly environments: ReadonlyArray<string>;
    }
  | { readonly kind: "unavailable"; readonly reason: "loading" };

/**
 * Resolves the id of a `t3-thread://v1/<id>` link, which names no environment, across every
 * enabled environment. The message's own environment wins; otherwise the id must match exactly
 * one other. The id as written is tried before its percent-decoded form, and opaque prefixes
 * (`mcp:`, `thread:`) stay part of the id.
 *
 * A thread is "not-found" only when every environment answered from a live list. A cached list
 * of a disconnected environment can still find a thread, but its silence proves nothing.
 */
export function resolveThreadAcrossEnvironments<Shell extends { readonly id: ThreadId }>(input: {
  readonly threadId: ThreadId;
  readonly preferredEnvironmentId: EnvironmentId;
  readonly environments: ReadonlyArray<ThreadLinkEnvironment<Shell>>;
}): ThreadLinkResolution<Shell> {
  const decoded = percentDecodedThreadLinkId(input.threadId);
  for (const threadId of decoded === null ? [input.threadId] : [input.threadId, decoded]) {
    const holders = input.environments.filter((environment) => environment.threads.has(threadId));
    const preferred = holders.find(
      (environment) => environment.environmentId === input.preferredEnvironmentId,
    );
    if (preferred !== undefined) return found(preferred, threadId, true);
    // The message's own machine is still loading: its list may yet hold this id, so wait for it.
    const own = input.environments.find(
      (environment) => environment.environmentId === input.preferredEnvironmentId,
    );
    if (holders.length > 0 && own !== undefined && !own.live && own.connecting) {
      return { kind: "unavailable", reason: "loading" };
    }
    const [only, second] = holders;
    if (only !== undefined && second === undefined) return found(only, threadId, false);
    if (only !== undefined) {
      return {
        kind: "ambiguous",
        threadId,
        candidates: holders.map(({ environmentId, label }) => ({ environmentId, label })),
      };
    }
  }
  const unanswered = input.environments.filter((environment) => !environment.live);
  const disconnected = unanswered.filter((environment) => !environment.connecting);
  if (disconnected.length > 0) {
    return {
      kind: "unavailable",
      reason: "disconnected",
      environments: disconnected.map((environment) => environment.label),
    };
  }
  return unanswered.length > 0
    ? { kind: "unavailable", reason: "loading" }
    : { kind: "unavailable", reason: "not-found" };
}

/**
 * Where following a link goes: the thread where it was found. When it was not found (or the id
 * is ambiguous) it goes where the link was written, whose thread route says what is missing;
 * archived threads are not in the thread list but still open there.
 */
export function threadLinkTarget(
  resolution: ThreadLinkResolution<{ readonly id: ThreadId }>,
  written: { readonly environmentId: EnvironmentId; readonly threadId: ThreadId },
): { readonly environmentId: EnvironmentId; readonly threadId: ThreadId } {
  return resolution.kind === "found"
    ? { environmentId: resolution.environmentId, threadId: resolution.threadId }
    : written;
}

function found<Shell extends { readonly id: ThreadId }>(
  environment: ThreadLinkEnvironment<Shell>,
  threadId: ThreadId,
  inPreferredEnvironment: boolean,
): ThreadLinkResolution<Shell> {
  return {
    kind: "found",
    environmentId: environment.environmentId,
    label: environment.label,
    threadId,
    thread: environment.threads.get(threadId)!,
    inPreferredEnvironment,
  };
}

function resolutionsEqual<Shell extends { readonly id: ThreadId }>(
  left: ThreadLinkResolution<Shell>,
  right: ThreadLinkResolution<Shell>,
): boolean {
  if (left.kind !== right.kind) return false;
  switch (left.kind) {
    case "found": {
      const other = right as typeof left;
      return (
        left.environmentId === other.environmentId &&
        left.label === other.label &&
        left.threadId === other.threadId &&
        left.thread === other.thread &&
        left.inPreferredEnvironment === other.inPreferredEnvironment
      );
    }
    case "ambiguous": {
      const other = right as typeof left;
      return (
        left.threadId === other.threadId &&
        left.candidates.length === other.candidates.length &&
        left.candidates.every(
          (candidate, index) =>
            candidate.environmentId === other.candidates[index]?.environmentId &&
            candidate.label === other.candidates[index]?.label,
        )
      );
    }
    case "unavailable": {
      const other = right as typeof left;
      if (left.reason !== other.reason) return false;
      if (left.reason !== "disconnected" || other.reason !== "disconnected") return true;
      return (
        left.environments.length === other.environments.length &&
        left.environments.every((label, index) => label === other.environments[index])
      );
    }
  }
}

/**
 * Atoms that follow a thread link as environments connect and their thread lists load, so a
 * link component re-renders only when its own answer changes. Web and mobile both build it from
 * their own environment atoms.
 */
export function createThreadLinkAtoms(input: {
  readonly environmentsAtom: Atom.Atom<ReadonlyArray<EnvironmentConnectionSummary>>;
  readonly threadIndexAtom: (
    environmentId: EnvironmentId,
  ) => Atom.Atom<ReadonlyMap<ThreadId, OrchestrationV2ThreadShell>>;
  readonly shellStateValueAtom: (environmentId: EnvironmentId) => Atom.Atom<EnvironmentShellState>;
}) {
  // Narrows each shell stream to "is live", so other status changes do not re-run a link. Every
  // thread list update still re-runs each link atom; `resolutionsEqual` then keeps the previous
  // answer object, so a link component re-renders only when its own answer changes.
  const liveAtom = Atom.family((environmentId: EnvironmentId) =>
    Atom.make((get) => get(input.shellStateValueAtom(environmentId)).status === "live").pipe(
      Atom.withLabel(`thread-link-environment-live:${environmentId}`),
    ),
  );

  return Atom.family((key: string) => {
    const separator = key.indexOf("\u0000");
    const preferredEnvironmentId = key.slice(0, separator) as EnvironmentId;
    const threadId = key.slice(separator + 1) as ThreadId;
    let previous: ThreadLinkResolution<OrchestrationV2ThreadShell> | null = null;
    return Atom.make((get) => {
      const next = resolveThreadAcrossEnvironments({
        threadId,
        preferredEnvironmentId,
        environments: get(input.environmentsAtom)
          .filter((environment) => environment.isEnabled)
          .map((environment) => ({
            environmentId: environment.environmentId,
            label: environment.environmentLabel,
            live: get(liveAtom(environment.environmentId)),
            // "connected" without a live list is still loading it. An idle "available" environment
            // was never asked to connect and cannot answer.
            connecting:
              environment.connectionState === "connected" ||
              environment.connectionState === "connecting" ||
              environment.connectionState === "reconnecting",
            threads: get(input.threadIndexAtom(environment.environmentId)),
          })),
      });
      if (previous !== null && resolutionsEqual(previous, next)) return previous;
      previous = next;
      return next;
    }).pipe(Atom.withLabel(`thread-link:${key}`));
  });
}

/** The key for a link atom: the environment of the message that holds the link, then the id. */
export function threadLinkKey(preferredEnvironmentId: EnvironmentId, threadId: ThreadId): string {
  return `${preferredEnvironmentId}\u0000${threadId}`;
}
