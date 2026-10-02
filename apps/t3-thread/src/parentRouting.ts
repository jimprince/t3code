import type { OrchestrationThreadShell, SavedEnvironment } from "./types.js";

type Recipient = {
  subscriberThreadId: string;
  subscriberEnvironment: string;
  subscriberEnvironmentId?: string;
};
type Route = Recipient & { sourceThreadId: string; sourceEnvironment: string };
type Environments = {
  environments: ReadonlyArray<Pick<SavedEnvironment, "name" | "environmentId">>;
};

/** Stable descriptors survive pairing aliases changing; an unpaired descriptor stays scoped. */
export function recipientKey(route: Recipient, state?: Environments): string {
  const id =
    route.subscriberEnvironmentId ??
    state?.environments.find((environment) => environment.name === route.subscriberEnvironment)
      ?.environmentId;
  return JSON.stringify([id ?? route.subscriberEnvironment, route.subscriberThreadId]);
}

export function sameNotificationRoute(left: Route, right: Route, state?: Environments): boolean {
  return (
    left.sourceEnvironment === right.sourceEnvironment &&
    left.sourceThreadId === right.sourceThreadId &&
    recipientKey(left, state) === recipientKey(right, state)
  );
}

/** Only organizational metadata determines a parent; local UUIDs are scoped to the source host. */
export function matchesCurrentParent(
  thread: Pick<OrchestrationThreadShell, "parentThreadId" | "remoteParent">,
  route: Route,
  state?: Environments,
): boolean {
  if (thread.remoteParent) {
    return (
      recipientKey(route, state) ===
      JSON.stringify([thread.remoteParent.environmentId, thread.remoteParent.threadId])
    );
  }
  if (!thread.parentThreadId || thread.parentThreadId !== route.subscriberThreadId) return false;
  const sourceId = state?.environments.find(
    (environment) => environment.name === route.sourceEnvironment,
  )?.environmentId;
  return (
    recipientKey(route, state) ===
    JSON.stringify([sourceId ?? route.sourceEnvironment, thread.parentThreadId])
  );
}
