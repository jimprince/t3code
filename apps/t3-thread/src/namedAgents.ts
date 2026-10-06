import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { isRawThreadUuid, resolveSavedAgentTarget } from "./agent-targets.js";
import { classifyThread } from "./status.js";
import type { OrchestrationThreadShell, StateFile } from "./types.js";

/**
 * Named agents are server-side singletons: one per resource, one live thread at a
 * time. These helpers list them across paired environments and route a send by
 * name to the live incarnation, which the server starts when the agent is dormant.
 */
export interface NamedAgentSummary {
  name: string;
  projectId: string;
  workspaceRoot: string;
  scope: string | null;
  liveThreadId: string | null;
}

export interface NamedAgentClient {
  listNamedAgents(): Promise<NamedAgentSummary[]>;
  resolveNamedAgent(
    name: string,
    message?: string,
  ): Promise<{ threadId: string; started: boolean }>;
  listThreads(): Promise<OrchestrationThreadShell[]>;
}

export type NamedAgentClientFactory = (environment: string) => NamedAgentClient;

export interface NamedAgentListing {
  name: string;
  environment: string;
  scope: string | null;
  liveThreadId: string | null;
  status: string;
  folder: string;
}

/** Every named agent on the selected (or all) paired environments, with live status. */
export async function listNamedAgents(input: {
  state: StateFile;
  clientFactory: NamedAgentClientFactory;
  environment?: string;
}): Promise<{ agents: NamedAgentListing[]; unreachableEnvironments: string[] }> {
  const agents: NamedAgentListing[] = [];
  const unreachableEnvironments: string[] = [];
  for (const environment of input.state.environments) {
    if (input.environment && environment.name !== input.environment) continue;
    const client = input.clientFactory(environment.name);
    let summaries: NamedAgentSummary[];
    let threads: OrchestrationThreadShell[];
    try {
      [summaries, threads] = await Promise.all([client.listNamedAgents(), client.listThreads()]);
    } catch {
      unreachableEnvironments.push(environment.name);
      continue;
    }
    for (const summary of summaries) {
      const live = threads.find((thread) => thread.id === summary.liveThreadId);
      agents.push({
        name: summary.name,
        environment: environment.name,
        scope: summary.scope,
        liveThreadId: summary.liveThreadId,
        status: live ? classifyThread(live).state : "dormant",
        folder: summary.workspaceRoot,
      });
    }
  }
  return { agents, unreachableEnvironments };
}

/**
 * Route `send <name>` to a named agent when the name is not a saved alias or a
 * thread UUID. Returns null when no paired environment has an agent by that name.
 */
export async function routeToNamedAgent(input: {
  state: StateFile;
  name: string;
  message: string;
  clientFactory: NamedAgentClientFactory;
}): Promise<{ environment: string; threadId: string; started: boolean } | null> {
  if (resolveSavedAgentTarget(input.state, input.name) || isRawThreadUuid(input.name)) return null;
  const owners: string[] = [];
  for (const environment of input.state.environments) {
    const agents = await input
      .clientFactory(environment.name)
      .listNamedAgents()
      .catch(() => [] as NamedAgentSummary[]);
    if (agents.some((agent) => agent.name === input.name)) owners.push(environment.name);
  }
  if (owners.length === 0) return null;
  if (owners.length > 1) {
    throw new Error(
      `Named agent '${input.name}' exists in several paired environments: ${owners.join(", ")}.`,
    );
  }
  const environment = owners[0]!;
  const resolved = await input
    .clientFactory(environment)
    .resolveNamedAgent(input.name, input.message);
  return { environment, ...resolved };
}

/** Write starter AGENT.md and BRIEFING.md into a local agent folder, never overwriting. */
export function scaffoldAgentFolder(input: {
  folder: string;
  name: string;
  scope: string;
  environment: string;
}): string[] {
  NodeFS.mkdirSync(input.folder, { recursive: true });
  const written: string[] = [];
  const files: Array<[string, string]> = [
    [
      "AGENT.md",
      [
        "---",
        `name: ${input.name}`,
        `scope: ${input.scope}`,
        `environment: ${input.environment}`,
        "---",
        "",
        "## Owns",
        "",
        "## How to operate it",
        "",
        "## Safety rules",
        "- One bounded action at a time; confirm the result before the next.",
        "",
      ].join("\n"),
    ],
    ["BRIEFING.md", "## Current state\n\n## Open items\n\n## Memories\n"],
  ];
  for (const [file, contents] of files) {
    const target = NodePath.join(input.folder, file);
    if (NodeFS.existsSync(target)) continue;
    NodeFS.writeFileSync(target, contents);
    written.push(target);
  }
  return written;
}
