import {
  loadState as readRoutingState,
  saveState as writeRoutingState,
  updateState as updateRoutingState,
} from "@t3tools/shared/threadRoutingState";

import type {
  NotificationLevel,
  SavedAgent,
  SavedEnvironment,
  SavedNotification,
  SavedQueuedSend,
  SavedSubscription,
  StateFile,
} from "./types.js";

export type SubscriptionEndpoint = {
  threadId: string;
  name: string | null;
  environment: string;
};

export type CallerEnvironmentMetadata = {
  environmentName: string;
  environmentId: string;
};

export type NotifyPreference =
  | { kind: "none" }
  | { kind: "caller" }
  | { kind: "explicit"; subscriber: string };

const EMPTY_STATE: StateFile = {
  version: 1,
  environments: [],
  agents: [],
  subscriptions: [],
  notifications: [],
  queuedSends: [],
};

function normalizeState(parsed: Partial<StateFile>): StateFile {
  return {
    version: 1,
    environments: Array.isArray(parsed.environments) ? parsed.environments : [],
    agents: Array.isArray(parsed.agents) ? parsed.agents : [],
    subscriptions: Array.isArray(parsed.subscriptions) ? parsed.subscriptions : [],
    notifications: Array.isArray(parsed.notifications) ? parsed.notifications : [],
    // State files written before the send queue existed have no `queuedSends`.
    queuedSends: Array.isArray(parsed.queuedSends) ? parsed.queuedSends : [],
  };
}

export { resolveStateFile } from "@t3tools/shared/threadRoutingState";

export async function loadState(): Promise<StateFile> {
  return normalizeState(await readRoutingState(EMPTY_STATE));
}

export async function saveState(state: StateFile): Promise<void> {
  await writeRoutingState(state);
}

export async function updateState<T>(
  mutator: (
    state: StateFile,
  ) => Promise<{ state: StateFile; result: T }> | { state: StateFile; result: T },
): Promise<T> {
  return updateRoutingState(EMPTY_STATE, (state) => mutator(normalizeState(state)));
}

export function upsertEnvironment(
  environments: SavedEnvironment[],
  next: SavedEnvironment,
): SavedEnvironment[] {
  const remaining = environments.filter((env) => env.name !== next.name);
  return [...remaining, next].sort((a, b) => a.name.localeCompare(b.name));
}

export function upsertAgent(agents: SavedAgent[], next: SavedAgent): SavedAgent[] {
  const remaining = agents.filter((agent) => agent.name !== next.name);
  return [...remaining, next].sort((a, b) => a.name.localeCompare(b.name));
}

export function removeAgent(agents: SavedAgent[], name: string): SavedAgent[] {
  return agents.filter((agent) => agent.name !== name).sort((a, b) => a.name.localeCompare(b.name));
}

export function upsertSubscription(
  subscriptions: SavedSubscription[],
  next: SavedSubscription,
): SavedSubscription[] {
  const remaining = subscriptions.filter(
    (subscription) =>
      !(
        subscription.subscriberThreadId === next.subscriberThreadId &&
        subscription.sourceThreadId === next.sourceThreadId
      ),
  );
  return [...remaining, next].sort((a, b) =>
    `${a.subscriberAgentName ?? a.subscriberThreadId}:${a.sourceAgentName ?? a.sourceThreadId}`.localeCompare(
      `${b.subscriberAgentName ?? b.subscriberThreadId}:${b.sourceAgentName ?? b.sourceThreadId}`,
    ),
  );
}

export function removeSubscription(
  subscriptions: SavedSubscription[],
  input: { subscriberThreadId: string; sourceThreadId: string },
): SavedSubscription[] {
  return subscriptions.filter(
    (subscription) =>
      !(
        subscription.subscriberThreadId === input.subscriberThreadId &&
        subscription.sourceThreadId === input.sourceThreadId
      ),
  );
}

/**
 * Thread id for a subscription endpoint named by saved agent name or raw
 * thread id. A raw id must appear in a saved subscription, so a typo still
 * fails instead of silently matching nothing.
 */
export function resolveSubscriptionThreadId(state: StateFile, reference: string): string {
  const agent = state.agents.find((candidate) => candidate.name === reference);
  if (agent) {
    return agent.threadId;
  }
  const routed = state.subscriptions.some(
    (subscription) =>
      subscription.subscriberThreadId === reference || subscription.sourceThreadId === reference,
  );
  if (routed) {
    return reference;
  }
  throw new Error(`Unknown agent '${reference}'.`);
}

/** Subscriptions that notify `subscriberThreadId`, each with the command that removes it. */
export function describeSubscriptionsOf(state: StateFile, subscriberThreadId: string) {
  return state.subscriptions
    .filter((subscription) => subscription.subscriberThreadId === subscriberThreadId)
    .map((subscription) => ({
      source: subscription.sourceAgentName ?? subscription.sourceThreadId,
      sourceThreadId: subscription.sourceThreadId,
      sourceEnvironment: subscription.sourceEnvironment,
      unsubscribe: `t3-thread unsubscribe --subscriber ${subscription.subscriberThreadId} --watch ${subscription.sourceThreadId}`,
    }));
}

export function upsertNotification(
  notifications: SavedNotification[],
  next: SavedNotification,
): SavedNotification[] {
  const remaining = notifications.filter((notification) => notification.eventKey !== next.eventKey);
  return [...remaining, next].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export function upsertQueuedSend(
  queuedSends: SavedQueuedSend[],
  next: SavedQueuedSend,
): SavedQueuedSend[] {
  const remaining = queuedSends.filter((queued) => queued.id !== next.id);
  return [...remaining, next].sort((a, b) => a.sequence - b.sequence);
}

/**
 * Next FIFO position. Sequence numbers are global to the state file rather than
 * per thread so a single ordering exists even when the queue is inspected as a whole.
 */
export function nextQueuedSendSequence(queuedSends: SavedQueuedSend[]): number {
  return queuedSends.reduce((highest, queued) => Math.max(highest, queued.sequence), 0) + 1;
}

export function findAgentByThreadId(state: StateFile, threadId: string): SavedAgent | null {
  return state.agents.find((agent) => agent.threadId === threadId) ?? null;
}

export function resolveCallerThreadId(env: NodeJS.ProcessEnv = process.env): string | null {
  const value = env.T3_THREAD_ID?.trim();
  return value ? value : null;
}

export function resolveCallerEnvironmentMetadata(
  env: NodeJS.ProcessEnv = process.env,
): CallerEnvironmentMetadata | null {
  const environmentName = env.T3_ENVIRONMENT_NAME?.trim();
  const environmentId = env.T3_ENVIRONMENT_ID?.trim();
  if (!environmentName || !environmentId) {
    return null;
  }
  return {
    environmentName,
    environmentId,
  };
}

export function resolveCallerEndpointFromLocalContext(
  state: StateFile,
  threadId: string,
  callerEnvironment: CallerEnvironmentMetadata | null = null,
): SubscriptionEndpoint | null {
  // A paired caller descriptor disambiguates cached aliases with colliding UUIDs.
  const savedEnvironment = callerEnvironment
    ? state.environments.find((environment) => environment.environmentId === callerEnvironment.environmentId)
      ?? state.environments.find((environment) => environment.name === callerEnvironment.environmentName
        || environment.label === callerEnvironment.environmentName)
    : undefined;
  const savedAgent = state.agents.find((agent) => agent.threadId === threadId
    && (!savedEnvironment || agent.environment === savedEnvironment.name));
  if (savedAgent) {
    return { threadId: savedAgent.threadId, name: savedAgent.name, environment: savedAgent.environment };
  }
  if (!callerEnvironment) return null;

  return {
    threadId,
    name: null,
    environment: savedEnvironment?.name ?? callerEnvironment.environmentName,
  };
}

export function resolveNotifyPreference(
  notify: string | boolean | undefined,
  env: NodeJS.ProcessEnv = process.env,
  topLevel = false,
): NotifyPreference {
  if (notify === false || (topLevel && notify === undefined)) {
    return { kind: "none" };
  }

  if (typeof notify === "string") {
    const value = notify.trim();
    if (!value) {
      throw new Error("`--notify` subscriber value cannot be empty.");
    }
    return {
      kind: "explicit",
      subscriber: value,
    };
  }

  const callerThreadId = resolveCallerThreadId(env);
  if (callerThreadId) {
    return { kind: "caller" };
  }

  if (notify === true) {
    throw new Error(
      "T3_THREAD_ID is not set. Bare `agent create --notify` must run inside a T3 thread or specify `--notify <subscriber>`.",
    );
  }

  return { kind: "none" };
}

export function requireEnvironment(state: StateFile, name: string): SavedEnvironment {
  const found = state.environments.find((env) => env.name === name);
  if (!found) {
    throw new Error(`Unknown environment '${name}'.`);
  }
  return found;
}

export function requireAgent(state: StateFile, name: string): SavedAgent {
  const found = state.agents.find((agent) => agent.name === name);
  if (!found) {
    throw new Error(`Unknown agent '${name}'.`);
  }
  return found;
}

export function requireAgentByThreadId(state: StateFile, threadId: string): SavedAgent {
  const found = findAgentByThreadId(state, threadId);
  if (!found) {
    throw new Error(`Unknown thread '${threadId}' in local agent state.`);
  }
  return found;
}

export function buildSubscriptionRecord(
  caller: SubscriptionEndpoint,
  source: SubscriptionEndpoint,
  now: string,
  existing?: SavedSubscription | null,
  options: {
    baselineTurnId?: string | null;
    level?: NotificationLevel;
    inputReminderMinutes?: number;
    inactivityMinutes?: number;
  } = {},
): SavedSubscription {
  return {
    ...existing,
    inactivityMinutes: options.inactivityMinutes ?? existing?.inactivityMinutes ?? 0,
    inactivityObservation:
      options.inactivityMinutes !== undefined &&
      options.inactivityMinutes !== existing?.inactivityMinutes
        ? null
        : existing?.inactivityObservation,
    level: options.level ?? existing?.level ?? "all",
    inputReminderMinutes: options.inputReminderMinutes ?? existing?.inputReminderMinutes ?? 45,
    subscriberThreadId: caller.threadId,
    subscriberAgentName: caller.name,
    subscriberEnvironment: caller.environment,
    sourceThreadId: source.threadId,
    sourceAgentName: source.name,
    sourceEnvironment: source.environment,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    // Re-subscribing keeps the original baseline unless a new one is supplied.
    baselineTurnId: options.baselineTurnId ?? existing?.baselineTurnId ?? null,
  };
}

export function assertNotSelfSubscription(
  caller: SubscriptionEndpoint,
  source: SubscriptionEndpoint,
): void {
  if (caller.threadId === source.threadId) {
    throw new Error(`Subscriber '${caller.name ?? caller.threadId}' cannot subscribe to itself.`);
  }
}
