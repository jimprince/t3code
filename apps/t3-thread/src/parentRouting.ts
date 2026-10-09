import type {
  OrchestrationThreadShell,
  SavedEnvironment,
  SavedAgent,
  SavedSubscription,
  StateFile,
} from "./types.js";

type Recipient = {
  subscriberThreadId: string;
  subscriberEnvironment: string;
  subscriberEnvironmentId?: string;
};
type Route = Recipient & { sourceThreadId: string; sourceEnvironment: string };
type Environments = {
  handoverRedirects?: StateFile["handoverRedirects"];
  environments: ReadonlyArray<Pick<SavedEnvironment, "name" | "environmentId">>;
};

/** A host cutover redirects derived parent routes while the server completes its later metadata step. */
function handoverParent(threadId: string, environment: string, state?: Environments): string {
  const name =
    state?.environments.find((e) => e.name === environment || e.environmentId === environment)
      ?.name ?? environment;
  const redirect = state?.handoverRedirects?.find(
    (r) => r.oldThreadId === threadId && r.targetEnvironment === name,
  );
  return redirect?.successorThreadId ?? threadId;
}

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
      JSON.stringify([
        thread.remoteParent.environmentId,
        handoverParent(thread.remoteParent.threadId, thread.remoteParent.environmentId, state),
      ])
    );
  }
  if (
    !thread.parentThreadId ||
    handoverParent(thread.parentThreadId, route.sourceEnvironment, state) !==
      route.subscriberThreadId
  )
    return false;
  const sourceId = state?.environments.find(
    (environment) => environment.name === route.sourceEnvironment,
  )?.environmentId;
  return (
    recipientKey(route, state) ===
    JSON.stringify([
      sourceId ?? route.sourceEnvironment,
      handoverParent(thread.parentThreadId, route.sourceEnvironment, state),
    ])
  );
}

export function mapRouteEnvironment(state: StateFile, route: SavedSubscription): SavedSubscription {
  const environment = route.subscriberEnvironmentId
    ? state.environments.find(
        (environment) => environment.environmentId === route.subscriberEnvironmentId,
      )
    : state.environments.find((environment) => environment.name === route.subscriberEnvironment);
  return environment
    ? {
        ...route,
        subscriberEnvironment: environment.name,
        subscriberEnvironmentId: environment.environmentId,
      }
    : route;
}

export function parentInputRoute(
  state: StateFile,
  source: SavedAgent,
  thread: OrchestrationThreadShell,
  now: string,
): SavedSubscription | null {
  const originalParentId = thread.remoteParent?.threadId ?? thread.parentThreadId;
  const parentId = originalParentId
    ? handoverParent(
        originalParentId,
        thread.remoteParent?.environmentId ?? source.environment,
        state,
      )
    : null;
  if (!parentId || thread.archivedAt || thread.settledOverride === "settled") return null;
  const remoteEnvironment = thread.remoteParent
    ? state.environments.find(
        (environment) => environment.environmentId === thread.remoteParent!.environmentId,
      )
    : null;
  const parentEnvironment = thread.remoteParent
    ? (remoteEnvironment?.name ?? thread.remoteParent.environmentId)
    : source.environment;
  const parent = state.agents.find(
    (agent) => agent.threadId === parentId && agent.environment === parentEnvironment,
  );
  return {
    nestingDerived: true,
    events: "attention",
    sourceThreadId: thread.id,
    sourceAgentName: source.name === thread.id ? null : source.name,
    sourceEnvironment: source.environment,
    subscriberThreadId: parentId,
    subscriberAgentName: parent?.name ?? null,
    subscriberEnvironment: parentEnvironment,
    ...(thread.remoteParent ? { subscriberEnvironmentId: thread.remoteParent.environmentId } : {}),
    createdAt: now,
    updatedAt: now,
  };
}
