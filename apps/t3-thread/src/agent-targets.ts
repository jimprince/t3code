import { findAgentByThreadId, requireEnvironment } from "./state.js";

import type { RemoteEnvironmentClient } from "./client.js";
import type { OrchestrationThreadShell, SavedAgent, StateFile } from "./types.js";

export type ResolvedAgentTarget = {
  input: string;
  environment: string;
  threadId: string;
  projectId: string;
  title: string;
  savedAgent: SavedAgent | null;
  checkedEnvironments: string[];
};

export type ThreadShellClient = Pick<RemoteEnvironmentClient, "listThreads">;

const THREAD_UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function orderedEnvironmentNames(state: StateFile, preferredEnvironment?: string): string[] {
  return [
    ...(preferredEnvironment ? [preferredEnvironment] : []),
    ...state.environments.map((environment) => environment.name),
  ].filter((value, index, list) => list.indexOf(value) === index);
}

export function isRawThreadUuid(value: string): boolean {
  return THREAD_UUID_PATTERN.test(value.trim());
}

export function resolveSavedAgentTarget(
  state: StateFile,
  input: string,
): Omit<ResolvedAgentTarget, "checkedEnvironments"> | null {
  const savedByName = state.agents.find((agent) => agent.name === input);
  if (savedByName) {
    return {
      input,
      environment: savedByName.environment,
      threadId: savedByName.threadId,
      projectId: savedByName.projectId,
      title: savedByName.title,
      savedAgent: savedByName,
    };
  }

  const savedByThreadId = findAgentByThreadId(state, input);
  if (!savedByThreadId) {
    return null;
  }

  return {
    input,
    environment: savedByThreadId.environment,
    threadId: savedByThreadId.threadId,
    projectId: savedByThreadId.projectId,
    title: savedByThreadId.title,
    savedAgent: savedByThreadId,
  };
}

export async function resolveAgentTarget(
  state: StateFile,
  input: string,
  options: {
    preferredEnvironment?: string;
    clientFactory: (environmentName: string) => ThreadShellClient;
  },
): Promise<ResolvedAgentTarget> {
  const local = resolveSavedAgentTarget(state, input);
  if (local) {
    return {
      ...local,
      checkedEnvironments: [local.environment],
    };
  }

  if (!isRawThreadUuid(input)) {
    throw new Error(`Unknown agent '${input}'.`);
  }

  const checkedEnvironments: string[] = [];
  for (const environmentName of orderedEnvironmentNames(state, options.preferredEnvironment)) {
    checkedEnvironments.push(environmentName);
    requireEnvironment(state, environmentName);
    const client = options.clientFactory(environmentName);
    const thread = (await client.listThreads()).find((candidate) => candidate.id === input);
    if (thread) {
      return {
        input,
        environment: environmentName,
        threadId: thread.id,
        projectId: thread.projectId,
        title: thread.title,
        savedAgent: null,
        checkedEnvironments,
      };
    }
  }

  const checked = checkedEnvironments.length > 0 ? checkedEnvironments.join(", ") : "(none)";
  throw new Error(`Unknown thread '${input}'. Checked paired environments: ${checked}.`);
}

export function assertSavedAgentCapability(
  target: ResolvedAgentTarget,
  capability: string,
): asserts target is ResolvedAgentTarget & { savedAgent: SavedAgent } {
  if (!target.savedAgent) {
    throw new Error(`${capability} requires a saved agent name. Raw thread UUIDs do not persist local state.`);
  }
}
