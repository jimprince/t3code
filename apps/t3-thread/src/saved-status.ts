import { RemoteEnvironmentClient } from "./client.js";
import { buildAgentOverview, formatOverviewLine } from "./monitor.js";
import { requireEnvironment } from "./state.js";
import { isMissingThread } from "./watch.js";
import type { SavedAgent, StateFile } from "./types.js";
import type { WatchClientFactory } from "./watch.js";

export async function readSavedStatus(
  agent: SavedAgent,
  state: StateFile,
  factory: WatchClientFactory = (environment) => new RemoteEnvironmentClient(environment),
): Promise<string> {
  try {
    const thread = await factory(requireEnvironment(state, agent.environment)).findThread(
      agent.threadId,
    );
    return formatOverviewLine(buildAgentOverview(agent, thread));
  } catch (error) {
    if (!isMissingThread(error)) throw error;
    return `${agent.name} [missing] ${agent.threadId} ${agent.title} :: saved mapping is stale; use t3-thread forget ${agent.name}`;
  }
}

/** Keep one projection alive at a time and let the output consumer apply backpressure. */
export async function streamSavedStatuses(
  state: StateFile,
  write: (line: string) => Promise<void>,
  factory: WatchClientFactory = (environment) => new RemoteEnvironmentClient(environment),
): Promise<void> {
  for (const agent of state.agents) {
    await write(await readSavedStatus(agent, state, factory));
  }
}
