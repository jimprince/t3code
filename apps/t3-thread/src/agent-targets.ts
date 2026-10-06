import { isPageAgentThreadId } from "@t3tools/contracts/pageAgents";

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
  unreachableEnvironments: string[];
};

/** `findThread` resolves page-agent threads, which no shell list contains. */
export type ThreadShellClient = Pick<RemoteEnvironmentClient, "listThreads"> &
  Partial<Pick<RemoteEnvironmentClient, "findThread">>;

export type ThreadSearchResult = {
  threadId: string;
  environment: string;
  projectId: string;
  saved: boolean;
  savedName: string | null;
  title: string;
  checkedEnvironments: string[];
  unreachableEnvironments: string[];
};

type ResolveAgentTargetOptions = {
  preferredEnvironment?: string;
  environmentFilter?: string;
  requireUniqueRemoteMatch?: boolean;
  clientFactory: (environmentName: string) => ThreadShellClient;
};

const THREAD_UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function orderedEnvironmentNames(
  state: StateFile,
  options: Pick<ResolveAgentTargetOptions, "preferredEnvironment" | "environmentFilter">,
): string[] {
  if (options.environmentFilter) {
    return [options.environmentFilter];
  }

  return [
    ...(options.preferredEnvironment ? [options.preferredEnvironment] : []),
    ...state.environments.map((environment) => environment.name),
  ].filter((value, index, list) => list.indexOf(value) === index);
}

export function isRawThreadUuid(value: string): boolean {
  // IDs are opaque. Preserve embedded percent escapes in delegated command namespaces.
  const id = value.trim();
  return THREAD_UUID_PATTERN.test(id) || /^(?:thread:|automation:)[^\s]+$/.test(id);
}

export function assertThreadSearchUuid(value: string): void {
  if (!isRawThreadUuid(value)) {
    throw new Error(`Expected a full T3 thread ID, received '${value}'.`);
  }
}

export function assertSavedAgentCapability(
  target: ResolvedAgentTarget,
  capability: string,
): asserts target is ResolvedAgentTarget & { savedAgent: SavedAgent } {
  if (!target.savedAgent) {
    throw new Error(
      `${capability} requires a saved agent name. Raw thread IDs do not persist local state.`,
    );
  }
}

export function resolveSavedAgentTarget(
  state: StateFile,
  input: string,
):
  | (Omit<ResolvedAgentTarget, "checkedEnvironments" | "unreachableEnvironments" | "savedAgent"> & {
      savedAgent: SavedAgent;
    })
  | null {
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
  options: ResolveAgentTargetOptions,
): Promise<ResolvedAgentTarget> {
  if (options.environmentFilter) {
    requireEnvironment(state, options.environmentFilter);
  }

  const local = resolveSavedAgentTarget(state, input);
  if (local) {
    if (options.environmentFilter && local.environment !== options.environmentFilter) {
      throw new Error(
        `Thread '${input}' is saved as '${local.savedAgent.name}' in environment '${local.environment}', which does not match --env '${options.environmentFilter}'. Omit --env to use the saved mapping.`,
      );
    }
    return {
      ...local,
      checkedEnvironments: [local.environment],
      unreachableEnvironments: [],
    };
  }

  const pageAgent = isPageAgentThreadId(input.trim());
  if (!isRawThreadUuid(input) && !pageAgent) {
    throw new Error(`Unknown agent '${input}'.`);
  }

  const checkedEnvironments: string[] = [];
  const unreachableEnvironments: string[] = [];
  const matches: ResolvedAgentTarget[] = [];
  for (const environmentName of orderedEnvironmentNames(state, options)) {
    checkedEnvironments.push(environmentName);
    requireEnvironment(state, environmentName);
    let thread: Pick<OrchestrationThreadShell, "id" | "projectId" | "title"> | undefined;
    const client = options.clientFactory(environmentName);
    if (pageAgent) {
      // Hidden from shell lists, so read it directly; a miss means another environment.
      thread = await client.findThread?.(input.trim()).catch(() => undefined);
    } else {
      let threads: OrchestrationThreadShell[];
      try {
        threads = await client.listThreads();
      } catch {
        unreachableEnvironments.push(environmentName);
        continue;
      }
      thread = threads.find((candidate) =>
        THREAD_UUID_PATTERN.test(input.trim())
          ? candidate.id.toLowerCase() === input.trim().toLowerCase()
          : candidate.id === input.trim(),
      );
    }
    if (thread) {
      const match = {
        input,
        environment: environmentName,
        threadId: thread.id,
        projectId: thread.projectId,
        title: thread.title,
        savedAgent: null,
        checkedEnvironments,
        unreachableEnvironments,
      };
      if (!options.requireUniqueRemoteMatch) {
        return match;
      }
      matches.push(match);
    }
  }

  if (matches.length === 1) {
    return matches[0]!;
  }

  if (matches.length > 1) {
    throw new Error(
      `Thread '${input}' was found in multiple paired environments: ${matches.map((match) => match.environment).join(", ")}. Use --env <name> to select one.`,
    );
  }

  const checked = checkedEnvironments.length > 0 ? checkedEnvironments.join(", ") : "(none)";
  const unavailable =
    unreachableEnvironments.length > 0
      ? ` Unreachable environments: ${unreachableEnvironments.join(", ")}. Their contents could not be checked.`
      : "";
  throw new Error(
    `Unknown thread '${input}'. Checked paired environments: ${checked}.${unavailable}`,
  );
}

export function toThreadSearchResult(target: ResolvedAgentTarget): ThreadSearchResult {
  return {
    threadId: target.threadId,
    environment: target.environment,
    projectId: target.projectId,
    saved: target.savedAgent !== null,
    savedName: target.savedAgent?.name ?? null,
    title: target.title,
    checkedEnvironments: target.checkedEnvironments,
    unreachableEnvironments: target.unreachableEnvironments,
  };
}

export function toUnsavedAgent(thread: OrchestrationThreadShell, environment: string): SavedAgent {
  return {
    name: thread.id,
    environment,
    threadId: thread.id,
    projectId: thread.projectId,
    title: thread.title,
    createdAt: thread.createdAt,
    lastSeenAssistantMessageId: null,
  };
}
