import { mkdir, open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

import type {
  SavedAgent,
  SavedEnvironment,
  SavedNotification,
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

const DEFAULT_STATE_DIR = path.join(os.homedir(), ".config", "t3-remote-agents");
const DEFAULT_STATE_FILE = path.join(DEFAULT_STATE_DIR, "state.json");
const STATE_LOCK_TIMEOUT_MS = 10_000;
const STATE_LOCK_RETRY_MS = 50;

const EMPTY_STATE: StateFile = {
  version: 1,
  environments: [],
  agents: [],
  subscriptions: [],
  notifications: [],
};

export function resolveStateFile(): string {
  return process.env.T3_AGENT_STATE_FILE?.trim() || DEFAULT_STATE_FILE;
}

async function ensureStateDir(stateFile: string): Promise<void> {
  await mkdir(path.dirname(stateFile), { recursive: true });
}

function normalizeState(parsed: Partial<StateFile>): StateFile {
  return {
    version: 1,
    environments: Array.isArray(parsed.environments) ? parsed.environments : [],
    agents: Array.isArray(parsed.agents) ? parsed.agents : [],
    subscriptions: Array.isArray(parsed.subscriptions) ? parsed.subscriptions : [],
    notifications: Array.isArray(parsed.notifications) ? parsed.notifications : [],
  };
}

async function loadStateFromFile(stateFile: string): Promise<StateFile> {
  try {
    const raw = await readFile(stateFile, "utf8");
    const parsed = JSON.parse(raw) as Partial<StateFile>;
    return normalizeState(parsed);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("ENOENT")) {
      return structuredClone(EMPTY_STATE);
    }
    throw error;
  }
}

export async function loadState(): Promise<StateFile> {
  return loadStateFromFile(resolveStateFile());
}

async function saveStateToFile(stateFile: string, state: StateFile): Promise<void> {
  await ensureStateDir(stateFile);
  const tempFile = path.join(path.dirname(stateFile), `.${path.basename(stateFile)}.${randomUUID()}.tmp`);
  await writeFile(tempFile, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  await rename(tempFile, stateFile);
}

export async function saveState(state: StateFile): Promise<void> {
  await saveStateToFile(resolveStateFile(), state);
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function withStateLock<T>(stateFile: string, task: () => Promise<T>): Promise<T> {
  await ensureStateDir(stateFile);
  const lockFile = `${stateFile}.lock`;
  const startedAt = Date.now();

  for (;;) {
    try {
      const handle = await open(lockFile, "wx");
      try {
        await handle.writeFile(`${process.pid}\n`, "utf8");
        return await task();
      } finally {
        await handle.close();
        await unlink(lockFile).catch(() => {});
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes("EEXIST")) {
        throw error;
      }
      if (Date.now() - startedAt > STATE_LOCK_TIMEOUT_MS) {
        throw new Error(`Timed out waiting for state lock '${lockFile}'.`);
      }
      await sleep(STATE_LOCK_RETRY_MS);
    }
  }
}

export async function updateState<T>(
  mutator: (state: StateFile) => Promise<{ state: StateFile; result: T }> | { state: StateFile; result: T },
): Promise<T> {
  const stateFile = resolveStateFile();
  return withStateLock(stateFile, async () => {
    const current = await loadStateFromFile(stateFile);
    const { state, result } = await mutator(current);
    await saveStateToFile(stateFile, state);
    return result;
  });
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

export function upsertNotification(
  notifications: SavedNotification[],
  next: SavedNotification,
): SavedNotification[] {
  const remaining = notifications.filter((notification) => notification.eventKey !== next.eventKey);
  return [...remaining, next].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
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
  const savedAgent = findAgentByThreadId(state, threadId);
  if (savedAgent) {
    return {
      threadId: savedAgent.threadId,
      name: savedAgent.name,
      environment: savedAgent.environment,
    };
  }

  if (!callerEnvironment) {
    return null;
  }

  const savedEnvironment = state.environments.find(
    (environment) =>
      environment.environmentId === callerEnvironment.environmentId ||
      environment.name === callerEnvironment.environmentName ||
      environment.label === callerEnvironment.environmentName,
  );

  return {
    threadId,
    name: null,
    environment: savedEnvironment?.name ?? callerEnvironment.environmentName,
  };
}

export function resolveNotifyPreference(
  notify: string | boolean | undefined,
  env: NodeJS.ProcessEnv = process.env,
): NotifyPreference {
  if (notify === false) {
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
): SavedSubscription {
  return {
    subscriberThreadId: caller.threadId,
    subscriberAgentName: caller.name,
    subscriberEnvironment: caller.environment,
    sourceThreadId: source.threadId,
    sourceAgentName: source.name,
    sourceEnvironment: source.environment,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
}

export function assertNotSelfSubscription(caller: SubscriptionEndpoint, source: SubscriptionEndpoint): void {
  if (caller.threadId === source.threadId) {
    throw new Error(`Subscriber '${caller.name ?? caller.threadId}' cannot subscribe to itself.`);
  }
}
