#!/usr/bin/env node
import { registerAutomationCommands } from "./automations.js";

import { parseInactivityMinutes } from "./inactivity.js";
import { Command } from "commander";

import { readSavedStatus } from "./saved-status.js";

import {
  assertSavedAgentCapability,
  assertThreadSearchUuid,
  resolveAgentTarget,
  toThreadSearchResult,
} from "./agent-targets.js";
import { parseInputReminderMinutes } from "./inputReminders.js";
import { buildFollowUpMessage } from "./agentPrompts.js";
import { sendDirectResult } from "./directResult.js";
import { RemoteEnvironmentClient } from "./client.js";
import {
  cancelDeferredSettlement,
  parseSettlementRequest,
  runDeferredSettlement,
  startDeferredSettlement,
} from "./deferredSettlement.js";
import { formatCliError } from "./errorOutput.js";
import { buildUserInputAnswers, findPendingRequests, resolveCreateParent } from "./nesting.js";
import { resolvePairingTarget } from "./http.js";
import {
  buildAgentOverview,
  getLatestTurnAssistantMessage,
  formatInboxLine,
  getLatestAssistantMessage,
  hasNewAssistantOutput,
  needsAttention,
  summarizeMessageText,
} from "./monitor.js";
import { parseNotificationLevel } from "./notifications.js";
import {
  classifyThread,
  formatThreadLine,
  selectThreadChildren,
  subscriptionBaselineTurnId,
} from "./status.js";
import { DEFAULT_RECOVERY_WINDOW_DAYS, runWorktreeGc } from "./worktreeGc.js";
import {
  assertNotSelfSubscription,
  buildSubscriptionRecord,
  describeSubscriptionsOf,
  loadState,
  requireAgent,
  requireEnvironment,
  removeAgent,
  removeSubscription,
  resolveCallerEndpointFromLocalContext,
  resolveCallerEnvironmentMetadata,
  resolveCallerThreadId,
  resolveNotifyPreference,
  resolveSubscriptionThreadId,
  updateState,
  upsertAgent,
  upsertSubscription,
  upsertEnvironment,
} from "./state.js";
import {
  cancelQueuedSend,
  drainQueuedSends,
  hasQueuedWork,
  listQueuedSends,
  summarizeQueuedSends,
} from "./sendQueue.js";
import { withSenderHeader } from "./thread-identity.js";
import {
  planExplicitThreadOrder,
  planThreadMove,
  sameThreadOrderGroup,
  sortThreadOrderGroup,
  threadOrderSection,
} from "./threadOrder.js";
import { claimWatcherLease, ensureWatcherProcess } from "./watcher-process.js";
import {
  decideWatcherExit,
  deliverPendingNotifications,
  detectAttentionEvents,
  hasActiveWork,
  createWatchPoller,
  nextWatchInterval,
  releaseHeldNotifications,
  unblockNotificationsForEnvironment,
} from "./watch.js";
import type { CallerEnvironmentMetadata, SubscriptionEndpoint } from "./state.js";
import type { SavedAgent, SavedNotification, SavedQueuedSend } from "./types.js";
import type { MessageOrigin } from "@t3tools/shared/messageOrigin";
import { listNamedAgents, routeToNamedAgent, scaffoldAgentFolder } from "./namedAgents.js";

function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function printLines(lines: string[]): void {
  process.stdout.write(lines.join("\n"));
  process.stdout.write("\n");
}

function collectOption(value: string, previous: string[] = []): string[] {
  return [...previous, value];
}

async function withAgent(agentName: string): Promise<{
  state: Awaited<ReturnType<typeof loadState>>;
  agent: SavedAgent;
  client: RemoteEnvironmentClient;
  saved: boolean;
  target: Awaited<ReturnType<typeof resolveAgentTarget>>;
}> {
  const state = await loadState();
  const agentTarget = await resolveAgentTarget(state, agentName, {
    clientFactory: (environmentName) =>
      new RemoteEnvironmentClient(requireEnvironment(state, environmentName)),
  });
  const environment = requireEnvironment(state, agentTarget.environment);
  return {
    state,
    agent: agentTarget.savedAgent ?? {
      name: agentTarget.threadId,
      environment: agentTarget.environment,
      threadId: agentTarget.threadId,
      projectId: agentTarget.projectId,
      title: agentTarget.title,
      createdAt: new Date().toISOString(),
      lastSeenAssistantMessageId: null,
    },
    client: new RemoteEnvironmentClient(environment),
    saved: agentTarget.savedAgent !== null,
    target: agentTarget,
  };
}

/**
 * Resolves `--parent` to a thread id: a saved agent name (which must live in
 * the same environment as the worker) or a raw thread id.
 */
function resolveParentThreadId(
  state: Awaited<ReturnType<typeof loadState>>,
  reference: string,
  environment: string,
): string {
  const saved = state.agents.find((agent) => agent.name === reference);
  if (!saved) return reference;
  if (saved.environment !== environment) {
    throw new Error(
      `Agent '${reference}' is in '${saved.environment}', not '${environment}'. Threads nest only within one environment and project.`,
    );
  }
  return saved.threadId;
}

/** Resolves parent ownership without writing to the parent's server. */
async function resolveParentLink(
  state: Awaited<ReturnType<typeof loadState>>,
  reference: string,
  childEnvironment: string,
): Promise<{
  parentThreadId: string | null;
  remoteParent?: { environmentId: string; threadId: string };
  parentEnvironmentName?: string;
}> {
  const caller =
    reference === resolveCallerThreadId()
      ? resolveCallerEndpointFromLocalContext(state, reference, resolveCallerEnvironmentMetadata())
      : null;
  const target =
    caller ??
    (await resolveAgentTarget(state, reference, {
      preferredEnvironment: childEnvironment,
      clientFactory: (name) => new RemoteEnvironmentClient(requireEnvironment(state, name)),
    }));
  const parentEnvironment = requireEnvironment(state, target.environment);
  if (target.environment === childEnvironment) return { parentThreadId: target.threadId };
  return {
    parentThreadId: null,
    remoteParent: { environmentId: parentEnvironment.environmentId, threadId: target.threadId },
    parentEnvironmentName: target.environment,
  };
}

function toSubscriptionEndpoint(agent: SavedAgent): SubscriptionEndpoint {
  return {
    threadId: agent.threadId,
    name: agent.name,
    environment: agent.environment,
  };
}

async function resolveThreadEndpoint(
  state: Awaited<ReturnType<typeof loadState>>,
  threadId: string,
  preferredEnvironment?: string,
  callerEnvironment?: CallerEnvironmentMetadata | null,
): Promise<SubscriptionEndpoint> {
  const localEndpoint = resolveCallerEndpointFromLocalContext(
    state,
    threadId,
    callerEnvironment ?? null,
  );
  if (localEndpoint) {
    return localEndpoint;
  }

  const orderedEnvironmentNames = [
    ...(preferredEnvironment ? [preferredEnvironment] : []),
    ...state.environments.map((environment) => environment.name),
  ].filter((value, index, list) => list.indexOf(value) === index);

  for (const environmentName of orderedEnvironmentNames) {
    const environment = requireEnvironment(state, environmentName);
    const client = new RemoteEnvironmentClient(environment);
    const threads = await client.listThreads();
    if (threads.some((thread) => thread.id === threadId)) {
      return {
        threadId,
        name: null,
        environment: environmentName,
      };
    }
  }

  throw new Error(
    `Unknown thread '${threadId}'. It is not saved locally and was not found in any paired environment.`,
  );
}

async function resolveNotifyEndpoint(
  state: Awaited<ReturnType<typeof loadState>>,
  notify: string | boolean | undefined,
  preferredEnvironment?: string,
  topLevel = false,
): Promise<SubscriptionEndpoint | null> {
  const callerEnvironment = resolveCallerEnvironmentMetadata();
  const preference = resolveNotifyPreference(notify, process.env, topLevel);

  if (preference.kind === "none") {
    return null;
  }

  if (preference.kind === "explicit") {
    const byName = state.agents.find((agent) => agent.name === preference.subscriber);
    if (byName) {
      return toSubscriptionEndpoint(byName);
    }
    return resolveThreadEndpoint(state, preference.subscriber, preferredEnvironment);
  }

  const threadId = resolveCallerThreadId();
  if (!threadId) {
    throw new Error("Internal error: caller notification was selected without a caller thread.");
  }
  return resolveThreadEndpoint(state, threadId, preferredEnvironment, callerEnvironment);
}

/** Origin for a send made from inside a T3 thread; a send from a plain terminal has none. */
type SendCommandOptions = { queue: boolean; coalesce?: string; progress?: boolean };
type QueueCommandOptions = { env?: string; open?: boolean; summary?: boolean };

function callerSendOrigin(state: Awaited<ReturnType<typeof loadState>>): MessageOrigin | null {
  const fromThreadId = resolveCallerThreadId();
  if (!fromThreadId) return null;
  const fromName = resolveCallerEndpointFromLocalContext(
    state,
    fromThreadId,
    resolveCallerEnvironmentMetadata(),
  )?.name;
  return { source: "thread-send", fromThreadId, ...(fromName ? { fromName } : {}) };
}

async function withCallerFromEnv(): Promise<{
  state: Awaited<ReturnType<typeof loadState>>;
  caller: SubscriptionEndpoint;
}> {
  const state = await loadState();
  const threadId = resolveCallerThreadId();
  if (!threadId) {
    throw new Error(
      "T3_THREAD_ID is not set. Run this command inside a T3 thread or specify the caller explicitly later.",
    );
  }
  return {
    state,
    caller: await resolveThreadEndpoint(
      state,
      threadId,
      undefined,
      resolveCallerEnvironmentMetadata(),
    ),
  };
}

function nowIso(): string {
  return new Date().toISOString();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function ensureNotificationWatcher(
  options: { env?: string; deliver?: boolean } = {},
): Promise<void> {
  await ensureWatcherProcess({
    env: options.env,
    intervalSeconds: 5,
    idleExitSeconds: 900,
    maxLifetimeSeconds: 86_400,
    deliver: options.deliver ?? true,
  });
}

const program = new Command();
const AGENT_COMMAND_ALIASES = new Set([
  "create",
  "rename",
  "attach",
  "list",
  "archive",
  "settle",
  "unsettle",
  "pin",
  "unpin",
  "auto-settle",
  "order",
  "move",
  "forget",
  "caller",
  "subscriptions",
  "subscribe",
  "unsubscribe",
  "notifications",
  "watch",
  "status",
  "worklog",
  "inbox",
  "implement",
  "send",
  "queue",
  "dequeue",
  "clarify",
  "revise",
  "complete",
  "interrupt",
  "wait",
  "result",
  "ack",
  "nest",
  "unnest",
  "issue",
  "request",
  "dashboard",
  "roadmap",
  "pending",
  "answer",
  "approve",
  "deny",
]);

if (AGENT_COMMAND_ALIASES.has(process.argv[2] ?? "")) {
  process.argv.splice(2, 0, "agent");
}

program.name("t3-thread").description("Operator CLI for T3 Code worker threads");
program.addHelpText(
  "after",
  `
Direct thread commands:
  project      Manage T3 Code projects on a paired environment
  models       List live provider/model slugs from a paired environment
  create       Create and start a branch-pinned T3 worker thread
  rename       Set a thread title by saved name or UUID
  search       Locate a thread UUID across paired environments
  pin/unpin    Change worker pinning (create --pin starts pinned)
  order/move  Arrange workers in their shared sidebar section
  agents       List named agents; add one or hand it over (send <name> routes to it)
  status       Show compact status for one saved worker or all workers
  worklog      Show recent T3 runtime/provider activity for a worker
  result       Fetch latest/final worker output
  implement    Start the latest Plan Ready proposal in build mode
  inbox        List workers with new output or attention states
  watch        Detect and deliver completion/attention notifications

Examples:
  t3-thread project list --env dev-vm
  t3-thread models --env dev-vm
  t3-thread project add --env dev-vm --path /home/brad/Programming/repo --title Repo --create-dir
  t3-thread create --name worker-a --env local-mbp --project PROJECT_ID --title "Worker A" --branch t3/worker-a --message "Fix the issue."
  t3-thread search 22222222-2222-4222-8222-222222222222
  t3-thread status worker-a
  t3-thread implement worker-a
  t3-thread result worker-a --wait 120 --final-message

Compatibility:
  Legacy nested forms like \`t3-thread agent create ...\` still work.
  \`t3-agent\` remains temporarily as a deprecated executable alias; new workflows should use \`t3-thread ...\`.
`,
);

program
  .command("pair")
  .requiredOption("--name <name>", "local environment name")
  .option("--pairing-url <url>", "full pairing URL")
  .option("--host <url>", "remote HTTP or WS base URL")
  .option("--credential <code>", "pairing code")
  .action(async (options) => {
    const target = resolvePairingTarget({
      pairingUrl: options.pairingUrl,
      host: options.host,
      credential: options.credential,
    });
    const paired = await RemoteEnvironmentClient.pair({
      name: options.name,
      httpBaseUrl: target.httpBaseUrl,
      wsBaseUrl: target.wsBaseUrl,
      credential: target.credential,
    });
    await updateState(async (state) => ({
      state: {
        ...state,
        environments: upsertEnvironment(state.environments, paired),
      },
      result: null,
    }));
    // Re-pairing is the only thing that clears deliveries blocked on expired
    // credentials, so release them here rather than waiting for a new event.
    const released = await unblockNotificationsForEnvironment(paired.name);
    if (released.length > 0) {
      await ensureNotificationWatcher({ env: paired.name });
    }
    printJson({
      name: paired.name,
      environmentId: paired.environmentId,
      label: paired.label,
      httpBaseUrl: paired.httpBaseUrl,
      expiresAt: paired.expiresAt,
      unblockedNotifications: released.length,
    });
  });

program
  .command("envs")
  .description("List saved environments")
  .action(async () => {
    const state = await loadState();
    printJson(
      state.environments.map((environment) => ({
        name: environment.name,
        environmentId: environment.environmentId,
        label: environment.label,
        serverVersion: environment.serverVersion,
        httpBaseUrl: environment.httpBaseUrl,
        expiresAt: environment.expiresAt,
      })),
    );
  });

program
  .command("threads")
  .requiredOption("--env <name>", "saved environment name")
  .option(
    "--parent <agent-or-thread>",
    "list children of this agent or thread in the selected environment",
  )
  .option("--recursive", "include all descendants (requires --parent)")
  .description("List remote thread shells, including nesting, settlement and pin state")
  .action(async (options) => {
    const state = await loadState();
    const environment = requireEnvironment(state, options.env);
    const client = new RemoteEnvironmentClient(environment);
    if (options.recursive && !options.parent) {
      throw new Error("--recursive requires --parent");
    }
    const parentLink = options.parent
      ? await resolveParentLink(state, options.parent, environment.name)
      : null;
    const threads = await client.listThreads();
    const titles = new Map(threads.map((thread) => [thread.id, thread.title]));
    const selected = parentLink
      ? selectThreadChildren(
          threads,
          parentLink.remoteParent?.threadId ?? parentLink.parentThreadId!,
          Boolean(options.recursive),
          parentLink.remoteParent?.environmentId,
        )
      : threads;
    printLines(
      selected.map((thread) => formatThreadLine(thread, titles.get(thread.parentThreadId ?? ""))),
    );
  });

program
  .command("models")
  .requiredOption("--env <name>", "saved environment name")
  .description("List live provider/model slugs from a paired T3 Code environment")
  .action(async (options) => {
    const state = await loadState();
    const environment = requireEnvironment(state, options.env);
    const client = new RemoteEnvironmentClient(environment);
    printJson(await client.listModels());
  });

const environmentCommands = program.command("env").description("Manage saved environments");

environmentCommands
  .command("forget")
  .argument("<name>", "saved environment name")
  .option("--force", "Also remove local agents, subscriptions, notifications, and queued sends")
  .description("Forget a local pairing without contacting or deleting anything on the server")
  .action(async (name: string, options: { force?: boolean }) => {
    const result = await updateState((state) => {
      requireEnvironment(state, name);
      const agents = state.agents.filter((record) => record.environment !== name);
      const subscriptions = state.subscriptions.filter(
        (record) => record.sourceEnvironment !== name && record.subscriberEnvironment !== name,
      );
      const notifications = state.notifications.filter(
        (record) => record.sourceEnvironment !== name && record.subscriberEnvironment !== name,
      );
      const queuedSends = state.queuedSends.filter((record) => record.environment !== name);
      const removed = {
        agents: state.agents.length - agents.length,
        subscriptions: state.subscriptions.length - subscriptions.length,
        notifications: state.notifications.length - notifications.length,
        queuedSends: state.queuedSends.length - queuedSends.length,
      };
      if (!options.force && Object.values(removed).some((count) => count > 0)) {
        throw new Error(
          `Environment '${name}' still has local references (${removed.agents} agents, ` +
            `${removed.subscriptions} subscriptions, ${removed.notifications} notifications, ` +
            `${removed.queuedSends} queued sends). Use --force to remove them too.`,
        );
      }
      return {
        state: {
          ...state,
          environments: state.environments.filter((record) => record.name !== name),
          agents,
          subscriptions,
          notifications,
          queuedSends,
        },
        result: { environment: name, forgotten: true, removed },
      };
    });
    printJson(result);
  });

program
  .command("projects")
  .requiredOption("--env <name>", "saved environment name")
  .description("List remote projects so agents can target the correct project id")
  .action(async (options) => {
    const state = await loadState();
    const environment = requireEnvironment(state, options.env);
    const client = new RemoteEnvironmentClient(environment);
    const projects = await client.listProjects();
    printJson(
      projects.map((project) => ({
        id: project.id,
        title: project.title,
        workspaceRoot: project.workspaceRoot,
        defaultModelSelection: project.defaultModelSelection,
      })),
    );
  });

const worktree = program
  .command("worktree")
  .description("Manage the git worktrees T3 created for worker threads");

worktree
  .command("gc")
  .requiredOption("--env <name>", "saved environment name")
  .requiredOption("--local-state-dir <path>", "local T3 state directory containing environment-id")
  .option(
    "--recovery-window-days <days>",
    "keep a worktree for this long after its last thread was archived",
    String(DEFAULT_RECOVERY_WINDOW_DAYS),
  )
  .option("--execute", "remove the planned worktrees instead of only reporting them")
  .description("Retire worktrees whose threads are all archived, on this host")
  .action(async (options) => {
    const recoveryWindowDays = Number(options.recoveryWindowDays);
    if (!Number.isFinite(recoveryWindowDays) || recoveryWindowDays < 0) {
      throw new Error("`--recovery-window-days` must be a non-negative number.");
    }

    const state = await loadState();
    const environment = requireEnvironment(state, options.env);
    const client = new RemoteEnvironmentClient(environment);
    const descriptor = await client.describe();
    const plan = await runWorktreeGc({
      localStateDir: options.localStateDir,
      environmentId: descriptor.environmentId,
      listThreads: () => client.listWorktreeGcThreads(),
      recoveryWindowDays,
      execute: Boolean(options.execute),
    });

    printJson({
      environment: environment.name,
      recoveryWindowDays,
      executed: Boolean(options.execute),
      removable: plan.removable,
      retained: plan.retained,
      removals: plan.removals,
    });
  });

const project = program.command("project").description("Manage T3 Code projects");

const projectHealth = project
  .command("health")
  .description(
    "The project's health line, first on its page: on-track, at-risk, off-track or waiting-on-you, plus one sentence",
  );

projectHealth
  .command("show")
  .argument("<thread>", "saved agent name or raw thread UUID in the project")
  .action(async (reference) => {
    const { agent: target, client } = await withAgent(reference);
    const result = await client.projectDashboard<{ health?: unknown }>("projectDashboardGet", {
      threadId: target.threadId,
    });
    printJson({ health: result.health ?? null });
  });

projectHealth
  .command("set")
  .argument("<thread>", "saved agent name or raw thread UUID in the project")
  .argument("<status>", "on-track, at-risk, off-track or waiting-on-you")
  .argument("<sentence>", "one sentence: where the project stands and why")
  .action(async (reference, status, sentence) => {
    const { agent: target, client } = await withAgent(reference);
    printJson(
      await client.projectDashboard("projectDashboardSetHealth", {
        threadId: target.threadId,
        status,
        sentence,
      }),
    );
  });

const projectTracker = project
  .command("tracker")
  .description(
    "The project's Gitea tracker repository for requests and issues, when its code is not on Gitea",
  );

projectTracker
  .command("show")
  .argument("<thread>", "saved agent name or raw thread UUID in the project")
  .action(async (reference) => {
    const { agent: target, client } = await withAgent(reference);
    const result = await client.projectDashboard<{ tracker: string | null }>(
      "projectDashboardGet",
      { threadId: target.threadId },
    );
    printJson({ tracker: result.tracker });
  });

projectTracker
  .command("set")
  .argument("<thread>", "saved agent name or raw thread UUID in the project")
  .argument("<repository>", "owner/repo on the first Gitea instance, or the repository URL")
  .action(async (reference, repository) => {
    const { agent: target, client } = await withAgent(reference);
    printJson(
      await client.projectDashboard("projectDashboardSetTracker", {
        threadId: target.threadId,
        tracker: repository,
      }),
    );
  });

projectTracker
  .command("clear")
  .argument("<thread>", "saved agent name or raw thread UUID in the project")
  .action(async (reference) => {
    const { agent: target, client } = await withAgent(reference);
    printJson(
      await client.projectDashboard("projectDashboardSetTracker", {
        threadId: target.threadId,
        tracker: null,
      }),
    );
  });

project
  .command("list")
  .requiredOption("--env <name>", "saved environment name")
  .description("List remote projects so agents can target the correct project id")
  .action(async (options) => {
    const state = await loadState();
    const environment = requireEnvironment(state, options.env);
    const client = new RemoteEnvironmentClient(environment);
    const projects = await client.listProjects();
    printJson(
      projects.map((project) => ({
        id: project.id,
        title: project.title,
        workspaceRoot: project.workspaceRoot,
        defaultModelSelection: project.defaultModelSelection,
      })),
    );
  });

project
  .command("add")
  .requiredOption("--env <name>", "saved environment name")
  .requiredOption("--path <path>", "absolute workspace root on the target environment")
  .option("--title <title>", "project title; defaults to workspace basename")
  .option("--provider <provider>", "default model provider", "codex")
  .option("--model <model>", "default model slug")
  .option("--model-option <key=value>", "default model option; may be repeated", collectOption, [])
  .option("--no-default-model", "create the project with no default model selection")
  .option("--create-dir", "allow T3 Code to create the workspace root if it is missing")
  .description("Add a project to a paired T3 Code environment")
  .action(async (options) => {
    const state = await loadState();
    const environment = requireEnvironment(state, options.env);
    const client = new RemoteEnvironmentClient(environment);
    const added = await client.createProject({
      workspaceRoot: options.path,
      title: options.title,
      provider: options.defaultModel === false ? undefined : options.provider,
      model: options.model,
      modelOptionEntries: options.modelOption,
      noDefaultModel: options.defaultModel === false,
      createDir: Boolean(options.createDir),
    });
    printJson({
      environment: options.env,
      project: added,
      created: true,
    });
  });

project
  .command("rename")
  .requiredOption("--env <name>", "saved environment name")
  .argument("<project>", "project id or absolute workspace root")
  .argument("<title>", "new project title")
  .description("Rename a project on a paired T3 Code environment")
  .action(async (identifier, title, options) => {
    const state = await loadState();
    const environment = requireEnvironment(state, options.env);
    const client = new RemoteEnvironmentClient(environment);
    const renamed = await client.renameProject({
      identifier,
      title,
    });
    printJson({
      environment: options.env,
      project: renamed,
      renamed: true,
    });
  });

project
  .command("set-model")
  .requiredOption("--env <name>", "saved environment name")
  .argument("<project>", "project id or absolute workspace root")
  .option("--provider <provider>", "default model provider")
  .option("--model <model>", "default model slug; defaults to the provider's live app model")
  .option("--model-option <key=value>", "default model option; may be repeated", collectOption, [])
  .option("--clear", "clear the project default model selection")
  .description("Set or clear a project's default model selection")
  .action(async (identifier, options) => {
    if (!options.clear && !options.provider) {
      throw new Error("project set-model requires --provider, or --clear.");
    }
    const state = await loadState();
    const environment = requireEnvironment(state, options.env);
    const client = new RemoteEnvironmentClient(environment);
    const updated = await client.setProjectDefaultModel({
      identifier,
      provider: options.provider,
      model: options.model,
      modelOptionEntries: options.modelOption,
      clear: Boolean(options.clear),
    });
    printJson({
      environment: options.env,
      project: updated,
      updated: true,
    });
  });

project
  .command("remove")
  .requiredOption("--env <name>", "saved environment name")
  .argument("<project>", "project id or absolute workspace root")
  .option("--force", "remove a project even when it has active threads")
  .description("Remove a project from a paired T3 Code environment")
  .action(async (identifier, options) => {
    const state = await loadState();
    const environment = requireEnvironment(state, options.env);
    const client = new RemoteEnvironmentClient(environment);
    const removed = await client.removeProject({
      identifier,
      force: Boolean(options.force),
    });
    printJson({
      environment: options.env,
      project: removed.project,
      activeThreadCount: removed.activeThreadCount,
      removed: removed.removed,
      forced: Boolean(options.force),
    });
  });

const agent = program.command("agent").description("Manage named remote agents");

agent
  .command("create")
  .requiredOption("--name <name>", "local agent name")
  .requiredOption("--env <name>", "saved environment name")
  .requiredOption("--project <id>", "remote project id")
  .requiredOption("--title <title>", "thread title")
  .option("--provider <provider>", "model provider")
  .option("--model <model>", "model slug")
  .option("--branch <name>", "git branch for T3's native worktree bootstrap")
  .option("--worktree <path>", "deprecated; T3 chooses/manages worktree paths")
  .option("--base-branch <name>", "base branch for T3's native worktree bootstrap", "main")
  .option("--local-base", "create from the local base branch instead of the selected remote")
  .option("--runtime-mode <mode>", "thread runtime mode")
  .option("--interaction-mode <mode>", "thread interaction mode")
  .requiredOption(
    "--message <text>",
    "initial message (wrapped with the canonical T3 preamble unless --no-preamble)",
  )
  .option(
    "--no-preamble",
    "skip the canonical T3 worker preamble; send --message verbatim (rare; use for testing or non-standard worker types)",
  )
  .option(
    "--notify [subscriber]",
    "override the default subscriber for completion/attention events; omit the value to force the current T3 caller from T3_THREAD_ID",
  )
  .option(
    "--no-notify",
    "disable automatic completion/attention notifications for the created worker",
  )
  .option("--pin", "pin the new thread (default: unpinned)")
  .option(
    "--parent <agent-or-thread>",
    "nest the worker under this saved agent or thread (default: the calling thread)",
  )
  .option(
    "--notify-level <level>",
    "all, attention, or none (required escalations always deliver)",
    parseNotificationLevel,
    "all",
  )
  .option(
    "--inactivity-minutes <minutes>",
    "active worker silence threshold; recommend 15; 0 disables",
    parseInactivityMinutes,
  )
  .option(
    "--input-reminder-minutes <minutes>",
    "unanswered child reminder interval; 0 disables reminders",
    parseInputReminderMinutes,
  )
  .option("--settle-on-complete", "settle when a turn completes without pending input")
  .option("--no-settle-on-complete", "disable completion settlement for this worker")
  .option("--top-level", "list the worker in the sidebar instead of nesting it")
  .action(async (options) => {
    const state = await loadState();
    const environment = requireEnvironment(state, options.env);
    const notifyCaller = await resolveNotifyEndpoint(
      state,
      options.notify,
      options.env,
      options.topLevel === true,
    );
    if (options.worktree) {
      throw new Error(
        "`--worktree` is no longer supported by agent create. T3 chooses the worktree path; use `--branch` and `--base-branch` only.",
      );
    }
    const client = new RemoteEnvironmentClient(environment);
    // `options.preamble` is false only when `--no-preamble` was passed (Commander convention).
    const snapshot = await client.getShellSnapshot();
    const parentReference = options.topLevel ? null : (options.parent ?? resolveCallerThreadId());
    const parentLink =
      parentReference === null
        ? null
        : await resolveParentLink(state, parentReference, options.env);
    const nesting = resolveCreateParent({
      explicitParentThreadId: options.parent ? (parentLink?.parentThreadId ?? null) : null,
      remoteParent: parentLink?.remoteParent,
      topLevel: options.topLevel === true,
      serverSupportsNesting: await client.supportsThreadNesting(),
      callerThreadId: resolveCallerThreadId(),
      projectId: options.project,
      threads: snapshot.threads,
    });
    const created = await client.createAgentThread({
      pin: options.pin === true,
      parentThreadId: nesting.parentThreadId,
      remoteParent: "remoteParent" in nesting ? nesting.remoteParent : undefined,
      settleOnComplete: options.settleOnComplete,
      projectId: options.project,
      title: options.title,
      provider: options.provider,
      model: options.model,
      branch: options.branch,
      baseBranch: options.baseBranch,
      startFromOrigin: !options.localBase,
      runtimeMode: options.runtimeMode,
      interactionMode: options.interactionMode,
      initialMessage: options.message,
      ...(options.preamble === false
        ? {}
        : {
            workerContext: {
              name: options.name,
              notifyLevel: notifyCaller ? (options.notifyLevel ?? "all") : "none",
              parent: nesting.parentThreadId
                ? {
                    threadId: nesting.parentThreadId,
                    name:
                      state.agents.find(
                        (agent) =>
                          agent.threadId === nesting.parentThreadId &&
                          agent.environment === options.env,
                      )?.name ?? null,
                    title: snapshot.threads.find((thread) => thread.id === nesting.parentThreadId)
                      ?.title,
                    environment: environment.name,
                  }
                : parentLink?.remoteParent
                  ? {
                      threadId: parentLink.remoteParent.threadId,
                      name:
                        state.agents.find(
                          (agent) =>
                            agent.threadId === parentLink.remoteParent?.threadId &&
                            agent.environment === parentLink.parentEnvironmentName,
                        )?.name ?? null,
                      environment: parentLink.parentEnvironmentName ?? environment.name,
                    }
                  : null,
            },
          }),
    });
    const createdAt = new Date().toISOString();
    const savedAgent = {
      name: options.name,
      environment: options.env,
      threadId: created.threadId,
      projectId: created.projectId,
      title: created.title,
      createdAt,
      lastSeenAssistantMessageId: null,
    };
    await updateState(async (currentState) => {
      let subscriptions = currentState.subscriptions;
      if (notifyCaller) {
        assertNotSelfSubscription(notifyCaller, savedAgent);
        const existing = currentState.subscriptions.find(
          (subscription) =>
            subscription.subscriberThreadId === notifyCaller.threadId &&
            subscription.sourceThreadId === savedAgent.threadId,
        );
        subscriptions = upsertSubscription(
          currentState.subscriptions,
          buildSubscriptionRecord(notifyCaller, savedAgent, createdAt, existing, {
            level: options.notifyLevel,
            inputReminderMinutes: options.inputReminderMinutes,
            inactivityMinutes: options.inactivityMinutes,
          }),
        );
      }
      return {
        state: {
          ...currentState,
          agents: upsertAgent(currentState.agents, savedAgent),
          subscriptions,
        },
        result: null,
      };
    });
    if (notifyCaller) {
      void ensureNotificationWatcher({ env: options.env }).catch(() => {});
    }
    printJson({
      name: options.name,
      environment: options.env,
      threadId: created.threadId,
      projectId: created.projectId,
      title: created.title,
      notifySubscribed: Boolean(notifyCaller),
      notifyLevel: options.notifyLevel,
      notifySubscriberAgentName: notifyCaller?.name ?? null,
      notifySubscriberThreadId: notifyCaller?.threadId ?? null,
      pinned: created.pinned,
      nestedUnder: nesting.parentThreadId,
      remoteParent: "remoteParent" in nesting ? nesting.remoteParent : null,
      nesting: nesting.reason,
    });
  });

agent
  .command("rename")
  .argument("<agent-or-thread>", "saved agent name or raw thread UUID (including your own)")
  .option("--title <text>", "new thread title")
  .option("--scope <text>", "project scope shown with the thread")
  .option("--clear-scope", "remove the project scope")
  .action(async (reference, options) => {
    if (options.scope !== undefined && options.clearScope) {
      throw new Error("Use either --scope or --clear-scope, not both.");
    }
    if (options.title === undefined && options.scope === undefined && !options.clearScope) {
      throw new Error("Provide --title, --scope, or --clear-scope.");
    }
    const { agent: target, client } = await withAgent(reference);
    const renamed = await client.renameThread({
      threadId: target.threadId,
      ...(options.title !== undefined ? { title: options.title } : {}),
      ...(options.scope !== undefined
        ? { scope: options.scope }
        : options.clearScope
          ? { scope: null }
          : {}),
    });
    await updateState(async (state) => ({
      state: {
        ...state,
        agents: state.agents.map((saved) =>
          options.title !== undefined &&
          saved.environment === target.environment &&
          saved.threadId === target.threadId
            ? { ...saved, title: renamed.title }
            : saved,
        ),
      },
      result: null,
    }));
    printJson({
      ...renamed,
      environment: target.environment,
      renamed: options.title !== undefined,
      scopeUpdated: options.scope !== undefined || Boolean(options.clearScope),
    });
  });

agent
  .command("attach")
  .requiredOption("--name <name>", "local agent name")
  .requiredOption("--env <name>", "saved environment name")
  .requiredOption("--thread <id>", "remote thread id")
  .requiredOption("--project <id>", "remote project id")
  .option("--title <title>", "local title override")
  .action(async (options) => {
    await updateState(async (state) => ({
      state: {
        ...state,
        agents: upsertAgent(state.agents, {
          name: options.name,
          environment: options.env,
          threadId: options.thread,
          projectId: options.project,
          title: options.title ?? options.name,
          createdAt: new Date().toISOString(),
          lastSeenAssistantMessageId: null,
        }),
      },
      result: null,
    }));
    printJson({
      name: options.name,
      environment: options.env,
      threadId: options.thread,
      projectId: options.project,
    });
  });

agent.command("list").action(async () => {
  const state = await loadState();
  printJson(state.agents);
});

program
  .command("search")
  .description("Locate an exact thread UUID across saved mappings and paired environments")
  .argument("<thread-uuid>", "full T3 thread UUID")
  .option("--env <name>", "restrict remote search to one saved environment")
  .action(async (threadId, options) => {
    assertThreadSearchUuid(threadId);
    const state = await loadState();
    const target = await resolveAgentTarget(state, threadId, {
      environmentFilter: options.env,
      requireUniqueRemoteMatch: true,
      clientFactory: (environmentName) =>
        new RemoteEnvironmentClient(requireEnvironment(state, environmentName)),
    });
    printJson(toThreadSearchResult(target));
  });

program
  .command("settle-after-turn", { hidden: true })
  .argument("<request>")
  .action(async (json: string) => {
    const request = parseSettlementRequest(json);
    const environment = requireEnvironment(await loadState(), request.environment);
    await runDeferredSettlement(request, new RemoteEnvironmentClient(environment));
  });

agent
  .command("settle")
  .argument("<name>", "agent name or raw thread UUID")
  .option("--self", "Settle the calling thread after its current response finishes")
  .description("Settle a thread through the server lifecycle without archiving it")
  .action(async (name, options) => {
    const { state, agent: savedAgent, client } = await withAgent(name);
    // Notifications to a settled thread are held, not dropped; list what is
    // still routed here so the caller can cut it instead.
    const subscriptions = describeSubscriptionsOf(state, savedAgent.threadId);
    const withSubscriptions = (result: object) =>
      subscriptions.length === 0
        ? result
        : {
            ...result,
            subscriptions,
            subscriptionsNote:
              "Held while settled; the newest from each source arrives on unsettle. Unsubscribe to stop one.",
          };
    if (options.self && savedAgent.threadId === resolveCallerThreadId()) {
      const thread = await client.findThread(savedAgent.threadId);
      if (
        thread.latestTurn &&
        (thread.latestTurn.state === "running" ||
          thread.session?.status === "running" ||
          thread.session?.status === "starting")
      ) {
        printJson(
          withSubscriptions(
            await startDeferredSettlement({
              threadId: thread.id,
              environment: savedAgent.environment,
              turnId: thread.latestTurn.turnId,
              unsettledAt: thread.unsettledAt ?? null,
            }),
          ),
        );
        return;
      }
    }
    printJson(
      withSubscriptions(await client.settleThread(savedAgent.threadId, { self: options.self })),
    );
  });

for (const operation of ["pin", "unpin"] as const) {
  agent
    .command(operation)
    .description(
      operation === "pin"
        ? "Pin an existing thread, including a nested worker"
        : "Unpin an existing thread",
    )
    .argument("<name>", "agent name or raw thread UUID")
    .action(async (name) => {
      const { agent: savedAgent, client } = await withAgent(name);
      printJson(await client.setThreadPinned(savedAgent.threadId, operation === "pin"));
    });
}

agent
  .command("auto-settle")
  .description("Turn automatic settlement on or off for an existing thread")
  .argument("<name>", "agent name or raw thread UUID")
  .option("--off", "never settle this thread automatically")
  .option("--on", "allow automatic settlement again")
  .action(async (name, options: { on?: boolean; off?: boolean }) => {
    if (options.on === options.off) {
      throw new Error("Pass exactly one of --on or --off.");
    }
    const { agent: savedAgent, client } = await withAgent(name);
    printJson(await client.setThreadAutoSettle(savedAgent.threadId, options.on === true));
  });

agent
  .command("order")
  .description("Put listed sibling threads first; unlisted siblings retain their relative order")
  .requiredOption("--env <name>", "saved environment name")
  .option("--reset", "return the listed threads to automatic order")
  .argument("<threads...>", "saved agent names or raw thread UUIDs")
  .action(async (references: string[], options) => {
    const state = await loadState();
    const environment = requireEnvironment(state, options.env);
    const client = new RemoteEnvironmentClient(environment);
    const ids = references.map((reference) =>
      resolveParentThreadId(state, reference, environment.name),
    );
    const shells = await client.listThreads();
    const byId = new Map(shells.map((thread) => [thread.id, thread]));
    const selected = ids.map((id) => {
      const thread = byId.get(id);
      if (!thread) throw new Error(`Thread '${id}' was not found in '${environment.name}'.`);
      return thread;
    });
    if (options.reset) {
      for (const thread of selected) await client.resetThreadOrder(thread.id);
      printJson({ environment: environment.name, reset: ids });
      return;
    }
    const first = selected[0]!;
    const section = threadOrderSection(first);
    if (section === null) throw new Error(`Thread '${first.id}' is not in an orderable section.`);
    if (selected.some((thread) => !sameThreadOrderGroup(first, thread))) {
      throw new Error("All listed threads must be siblings in the same pinned or active section.");
    }
    const group = shells.filter((thread) => sameThreadOrderGroup(first, thread));
    const assignments = planExplicitThreadOrder({ group, leadingIds: ids });
    await client.applyThreadOrder(assignments.map((assignment) => ({ ...assignment, section })));
    printJson({
      environment: environment.name,
      section,
      order: [
        ...ids,
        ...sortThreadOrderGroup(group)
          .map((thread) => thread.id)
          .filter((id) => !ids.includes(id)),
      ],
      writes: assignments.length,
    });
  });

agent
  .command("move")
  .description("Move a thread before, after, to the top, or to the bottom of its sibling section")
  .argument("<thread>", "saved agent name or raw thread UUID")
  .option("--before <thread>", "place before this sibling")
  .option("--after <thread>", "place after this sibling")
  .option("--top", "place first")
  .option("--bottom", "place last")
  .action(async (reference, options) => {
    const destinations = [options.before, options.after, options.top, options.bottom].filter(
      Boolean,
    );
    if (destinations.length !== 1) {
      throw new Error("Choose exactly one of --before, --after, --top, or --bottom.");
    }
    const { state, agent: savedAgent, client } = await withAgent(reference);
    const shells = await client.listThreads();
    const thread = shells.find((candidate) => candidate.id === savedAgent.threadId);
    if (!thread) throw new Error(`Thread '${savedAgent.threadId}' was not found.`);
    const section = threadOrderSection(thread);
    if (section === null) throw new Error(`Thread '${thread.id}' is not in an orderable section.`);
    const resolveDestination = (value: string | undefined) =>
      value === undefined ? undefined : resolveParentThreadId(state, value, savedAgent.environment);
    const group = shells.filter((candidate) => sameThreadOrderGroup(thread, candidate));
    const assignments = planThreadMove({
      group,
      threadId: thread.id,
      beforeId: resolveDestination(options.before),
      afterId: resolveDestination(options.after),
      edge: options.top ? "top" : options.bottom ? "bottom" : undefined,
    });
    await client.applyThreadOrder(assignments.map((assignment) => ({ ...assignment, section })));
    printJson({
      threadId: thread.id,
      environment: savedAgent.environment,
      section,
      writes: assignments.length,
    });
  });

agent
  .command("unsettle")
  .argument("<name>", "agent name or raw thread UUID")
  .description("Return a settled thread to the active list without starting a turn")
  .action(async (name) => {
    const { agent: savedAgent, client } = await withAgent(name);
    await cancelDeferredSettlement(savedAgent.environment, savedAgent.threadId);
    const result = await client.unsettleThread(savedAgent.threadId);
    const released = await releaseHeldNotifications(savedAgent.threadId);
    if (released.length > 0) {
      await ensureNotificationWatcher();
    }
    printJson({ ...result, releasedNotifications: released.length });
  });

agent
  .command("archive")
  .argument("<name>", "agent name")
  .description("Archive the remote thread for a saved agent via T3 RPC")
  .action(async (name) => {
    const { agent: savedAgent, client, saved } = await withAgent(name);
    const archived = await client.archiveThread(savedAgent.threadId);
    printJson({
      agent: saved ? savedAgent.name : null,
      threadId: savedAgent.threadId,
      environment: savedAgent.environment,
      archived,
    });
  });

agent
  .command("forget")
  .argument("<name>", "agent name")
  .description("Remove a saved agent mapping and related local routing state")
  .action(async (name) => {
    const state = await loadState();
    const savedAgent = requireAgent(state, name);
    await updateState(async (currentState) => ({
      state: {
        ...currentState,
        agents: removeAgent(currentState.agents, name),
        subscriptions: currentState.subscriptions.filter(
          (subscription) =>
            subscription.subscriberThreadId !== savedAgent.threadId &&
            subscription.sourceThreadId !== savedAgent.threadId,
        ),
        notifications: currentState.notifications.filter(
          (notification) =>
            notification.subscriberThreadId !== savedAgent.threadId &&
            notification.sourceThreadId !== savedAgent.threadId,
        ),
      },
      result: null,
    }));
    printJson({
      agent: savedAgent.name,
      threadId: savedAgent.threadId,
      forgotten: true,
    });
  });

agent
  .command("caller")
  .description("Resolve the calling thread from T3_THREAD_ID and T3 environment metadata")
  .action(async () => {
    const state = await loadState();
    const threadId = resolveCallerThreadId();
    const caller = threadId
      ? await resolveThreadEndpoint(
          state,
          threadId,
          undefined,
          resolveCallerEnvironmentMetadata(),
        ).catch(() => null)
      : null;
    printJson({
      threadId,
      caller: caller
        ? {
            name: caller.name,
            environment: caller.environment,
            saved: caller.name !== null,
          }
        : null,
    });
  });

agent
  .command("subscriptions")
  .description("List saved attention-routing subscriptions")
  .option("--subscriber <name>", "filter by subscriber agent name or thread UUID")
  .option("--source <name>", "filter by source agent name or thread UUID")
  .action(async (options) => {
    const state = await loadState();
    const subscriptions = state.subscriptions.filter((subscription) => {
      if (
        options.subscriber &&
        subscription.subscriberAgentName !== options.subscriber &&
        subscription.subscriberThreadId !== options.subscriber
      ) {
        return false;
      }
      if (
        options.source &&
        subscription.sourceAgentName !== options.source &&
        subscription.sourceThreadId !== options.source
      ) {
        return false;
      }
      return true;
    });
    printJson(subscriptions);
  });

agent
  .command("subscribe")
  .description(
    "Subscribe the calling T3 thread to attention from a saved source agent or raw thread UUID",
  )
  .requiredOption("--watch <name>", "saved source agent name or raw thread UUID to watch")
  .option("--level <level>", "all, attention, or none", parseNotificationLevel)
  .option(
    "--inactivity-minutes <minutes>",
    "active worker silence threshold; recommend 15; 0 disables",
    parseInactivityMinutes,
  )
  .option(
    "--input-reminder-minutes <minutes>",
    "unanswered child reminder interval; 0 disables reminders",
    parseInputReminderMinutes,
  )
  .action(async (options) => {
    const { state, caller } = await withCallerFromEnv();
    const resolvedSource = await resolveAgentTarget(state, options.watch, {
      clientFactory: (environmentName) =>
        new RemoteEnvironmentClient(requireEnvironment(state, environmentName)),
    });
    const source = {
      threadId: resolvedSource.threadId,
      name: resolvedSource.savedAgent?.name ?? null,
      environment: resolvedSource.environment,
    };
    assertNotSelfSubscription(caller, source);
    const now = new Date().toISOString();
    // A source that is already idle when the subscription is created must not
    // have that old state routed as a new event; a source still mid-turn keeps
    // no baseline so the subscriber hears how that turn ends.
    let baselineTurnId: string | null = null;
    try {
      const sourceThread = await new RemoteEnvironmentClient(
        requireEnvironment(state, source.environment),
      ).findThread(source.threadId);
      baselineTurnId = subscriptionBaselineTurnId(sourceThread);
    } catch {
      // Unreachable source: subscribe anyway without a baseline.
    }
    const next = await updateState((currentState) => {
      const existing = currentState.subscriptions.find(
        (subscription) =>
          subscription.subscriberThreadId === caller.threadId &&
          subscription.sourceThreadId === source.threadId,
      );
      const next = buildSubscriptionRecord(caller, source, now, existing, {
        baselineTurnId: existing ? existing.baselineTurnId : baselineTurnId,
        level: options.level,
        inputReminderMinutes: options.inputReminderMinutes,
        inactivityMinutes: options.inactivityMinutes,
      });
      return {
        state: {
          ...currentState,
          subscriptions: upsertSubscription(currentState.subscriptions, next),
        },
        result: next,
      };
    });
    void ensureNotificationWatcher({ env: source.environment }).catch(() => {});
    printJson(next);
  });

agent
  .command("unsubscribe")
  .description("Remove an attention subscription for the calling T3 thread or --subscriber")
  .requiredOption("--watch <name>", "saved source agent name or raw thread UUID to stop watching")
  .option(
    "--subscriber <name>",
    "saved agent name or raw thread UUID of the subscriber (default: the calling thread)",
  )
  .action(async (options) => {
    let state: Awaited<ReturnType<typeof loadState>>;
    let subscriberThreadId: string;
    if (options.subscriber) {
      state = await loadState();
      subscriberThreadId = resolveSubscriptionThreadId(state, options.subscriber);
    } else {
      const fromEnv = await withCallerFromEnv();
      state = fromEnv.state;
      subscriberThreadId = fromEnv.caller.threadId;
    }
    const route = {
      subscriberThreadId,
      sourceThreadId: resolveSubscriptionThreadId(state, options.watch),
    };
    const existing = state.subscriptions.find(
      (subscription) =>
        subscription.subscriberThreadId === route.subscriberThreadId &&
        subscription.sourceThreadId === route.sourceThreadId,
    );
    await updateState(async (currentState) => ({
      state: {
        ...currentState,
        subscriptions: removeSubscription(currentState.subscriptions, route),
        notifications: currentState.notifications.map((notification) =>
          notification.subscriberThreadId === route.subscriberThreadId &&
          notification.sourceThreadId === route.sourceThreadId &&
          !["delivered", "superseded", "undeliverable"].includes(notification.status)
            ? {
                ...notification,
                status: "superseded" as const,
                updatedAt: new Date().toISOString(),
                nextAttemptAt: null,
              }
            : notification,
        ),
      },
      result: null,
    }));
    const agentName = (threadId: string) =>
      state.agents.find((candidate) => candidate.threadId === threadId)?.name ?? null;
    printJson({
      removed: existing !== undefined,
      subscriberAgentName: existing?.subscriberAgentName ?? agentName(route.subscriberThreadId),
      sourceAgentName: existing?.sourceAgentName ?? agentName(route.sourceThreadId),
      ...route,
    });
  });

agent
  .command("notifications")
  .description("List saved routed notification events")
  .option("--subscriber <name>", "filter by subscriber agent name or thread UUID")
  .option("--source <name>", "filter by source agent name or thread UUID")
  .option("--status <status>", "filter by notification status")
  .action(async (options) => {
    const state = await loadState();
    const notifications = state.notifications.filter((notification) => {
      if (
        options.subscriber &&
        notification.subscriberAgentName !== options.subscriber &&
        notification.subscriberThreadId !== options.subscriber
      ) {
        return false;
      }
      if (
        options.source &&
        notification.sourceAgentName !== options.source &&
        notification.sourceThreadId !== options.source
      ) {
        return false;
      }
      if (options.status && notification.status !== options.status) {
        return false;
      }
      return true;
    });
    printJson(notifications);
  });

agent
  .command("watch")
  .description(
    "Poll saved agents for attention-worthy transitions and route notifications to subscribers",
  )
  .option("--env <name>", "optional saved environment filter")
  .option("--interval <seconds>", "poll interval in seconds", "5")
  .option("--idle-exit <seconds>", "exit after this many idle seconds; 0 disables idle exit", "900")
  .option(
    "--max-lifetime <seconds>",
    "hard-stop the watcher after this many seconds; 0 disables the limit",
    "86400",
  )
  .option("--ensure", "spawn a detached singleton watcher if none is running, then exit")
  .option("--once", "run a single scan and exit")
  .option(
    "--no-deliver",
    "record notification events but do not send messages to subscriber threads",
  )
  .action(async (options) => {
    const intervalMs = Math.max(1, Number(options.interval)) * 1000;
    const idleExitMs = Math.max(0, Number(options.idleExit)) * 1000;
    const maxLifetimeMs = Math.max(0, Number(options.maxLifetime)) * 1000;

    if (options.ensure) {
      const ensured = await ensureWatcherProcess({
        env: options.env,
        intervalSeconds: Math.max(1, Number(options.interval)),
        idleExitSeconds: Math.max(0, Number(options.idleExit)),
        maxLifetimeSeconds: Math.max(0, Number(options.maxLifetime)),
        deliver: options.deliver,
      });
      printJson({
        ensured: true,
        ...ensured,
        env: options.env ?? null,
      });
      return;
    }

    const releaseLease = options.once ? null : await claimWatcherLease();
    if (!options.once && !releaseLease) {
      printJson({
        started: false,
        reason: "watcher already running",
        env: options.env ?? null,
      });
      return;
    }

    const startedAt = Date.now();
    let idleSince = 0;
    let handoff = false;
    const poller = createWatchPoller();

    try {
      for (;;) {
        poller.beginPoll();
        let detectedNotifications: SavedNotification[] = [];
        let deliveryResults: SavedNotification[] = [];
        let queuedSendResults: SavedQueuedSend[] = [];
        let scanError: string | null = null;

        try {
          detectedNotifications = await detectAttentionEvents({
            env: options.env,
            clientFactory: poller.clientFactory,
          });
          deliveryResults = options.deliver
            ? await deliverPendingNotifications({ env: options.env })
            : [];
          queuedSendResults = options.deliver
            ? await drainQueuedSends({
                clientFactory: (environment) => new RemoteEnvironmentClient(environment),
                env: options.env,
              })
            : [];
        } catch (error) {
          // One bad route must not end the watcher; the next scan retries.
          scanError = formatCliError(error);
        }

        const workRemaining =
          (await hasActiveWork({ env: options.env, clientFactory: poller.clientFactory })) ||
          hasQueuedWork(await loadState(), { env: options.env });
        printJson({
          scannedAt: nowIso(),
          env: options.env ?? null,
          deliver: options.deliver,
          detectedNotifications,
          deliveryResults,
          queuedSendResults,
          workRemaining,
          scanError,
          skippedMappings: poller.skippedMappings(),
          nextPollMs: nextWatchInterval(intervalMs, workRemaining),
        });

        if (options.once) {
          break;
        }

        const nowMs = Date.now();
        if (workRemaining) {
          idleSince = 0;
        } else {
          idleSince ||= nowMs;
        }

        const decision = decideWatcherExit({
          elapsedMs: nowMs - startedAt,
          idleMs: idleSince === 0 ? 0 : nowMs - idleSince,
          idleExitMs,
          maxLifetimeMs,
          workRemaining,
        });
        if (decision.exit) {
          handoff = decision.handoff;
          break;
        }

        // Backoff must not extend the configured idle or lifetime deadline.
        await sleep(
          Math.min(
            nextWatchInterval(intervalMs, workRemaining),
            idleExitMs > 0 && idleSince > 0
              ? Math.max(0, idleExitMs - (nowMs - idleSince))
              : Infinity,
            maxLifetimeMs > 0 ? Math.max(0, maxLifetimeMs - (nowMs - startedAt)) : Infinity,
          ),
        );
      }
    } finally {
      await releaseLease?.();
      if (handoff) {
        // Stopped by the lifetime backstop with events still undelivered: replace
        // ourselves instead of leaving them until some later CLI command runs.
        await ensureNotificationWatcher({
          ...(options.env ? { env: options.env } : {}),
          deliver: options.deliver,
        });
      }
    }
  });

agent
  .command("status")
  .argument("[name]", "agent name or raw thread UUID")
  .action(async (name) => {
    if (!name) {
      const state = await loadState();
      const summaries = await Promise.all(
        state.agents.map(async (savedAgent) => {
          return readSavedStatus(savedAgent, state);
        }),
      );
      printLines(summaries);
      return;
    }

    const { agent: savedAgent, client, saved, target } = await withAgent(name);
    const thread = await client.findThread(savedAgent.threadId);
    const status = classifyThread(thread);
    const latestAssistant = getLatestAssistantMessage(thread);
    const parentThreadId = thread.parentThreadId ?? null;
    const parentTitle = parentThreadId
      ? ((await client.listThreads()).find((parent) => parent.id === parentThreadId)?.title ?? null)
      : null;
    printJson({
      agent: saved ? savedAgent.name : null,
      environment: savedAgent.environment,
      threadId: savedAgent.threadId,
      title: savedAgent.title,
      projectId: savedAgent.projectId,
      saved,
      checkedEnvironments: target.checkedEnvironments,
      unreachableEnvironments: target.unreachableEnvironments,
      parentThreadId,
      remoteParent: thread.remoteParent ?? null,
      parentTitle,
      pinned: thread.pinnedAt != null,
      pinnedAt: thread.pinnedAt ?? null,
      settledOverride: thread.settledOverride ?? null,
      settledAt: thread.settledAt ?? null,
      unsettledAt: thread.unsettledAt ?? null,
      state: status.state,
      reason: status.reason,
      latestTurn: thread.latestTurn,
      session: thread.session,
      proposedPlans: thread.proposedPlans.length,
      messageCount: thread.messages.length,
      hasNewOutput: saved ? hasNewAssistantOutput(savedAgent, thread) : null,
      latestAssistantMessageId: latestAssistant?.id ?? null,
      latestAssistantPreview: latestAssistant ? summarizeMessageText(latestAssistant.text) : null,
      issues: thread.issues ?? [],
    });
  });

function assertItemKind(kind: string): void {
  if (kind !== "question" && kind !== "task" && kind !== "epic") {
    throw new Error("Kind must be question, task or epic.");
  }
}

const request = agent
  .command("request")
  .description(
    "Track Brad's requests (Gitea issues labeled ask). Only Brad settles a request; agents start it, mark it ready with a summary, or file one he asked for.",
  );

request
  .command("list")
  .argument("<thread>", "saved agent name or raw thread UUID in the project")
  .action(async (reference) => {
    const { agent: target, client } = await withAgent(reference);
    const result = await client.projectRequest<{
      issues: ReadonlyArray<Record<string, unknown>>;
    }>("projectRequestsList", { threadId: target.threadId });
    printJson(
      result.issues.map((item) => ({
        number: item.number,
        repository: item.repository,
        title: item.title,
        status: item.status,
        labels: item.labels,
        url: item.url,
        requestedIn: (item.requestSource as { threadId?: string } | null)?.threadId ?? null,
      })),
    );
  });

request
  .command("add")
  .argument("<thread>", "saved agent name or raw thread UUID that Brad asked")
  .argument("<title>", "the request in Brad's words")
  .option("--kind <kind>", "question, task or epic", "task")
  .option("--bug", "tag a task as a bug")
  .option("--detail <text>", "Brad's exact words or extra context")
  .action(async (reference, title, options: { kind: string; bug?: boolean; detail?: string }) => {
    assertItemKind(options.kind);
    const { agent: target, client } = await withAgent(reference);
    printJson(
      await client.projectRequest("projectRequestsCreate", {
        threadId: target.threadId,
        title,
        kind: options.kind,
        ...(options.bug ? { bug: true } : {}),
        ...(options.detail ? { detail: options.detail } : {}),
      }),
    );
  });

for (const [name, status, description] of [
  ["start", "in-progress", "Mark a request as being worked on (links your thread to it)"],
  ["reopen", "pending", "Return a request to pending"],
] as const) {
  request
    .command(name)
    .description(description)
    .argument("<thread>", "saved agent name or raw thread UUID in the project")
    .argument("<request>", "issue number in the project tracker, owner/repo#N, or issue URL")
    .option("--summary <text>", "comment for Brad")
    .action(async (reference, requestReference, options: { summary?: string }) => {
      const { agent: target, client } = await withAgent(reference);
      printJson(
        await client.projectRequest("projectRequestsUpdate", {
          threadId: target.threadId,
          reference: requestReference,
          status,
          ...(options.summary ? { comment: options.summary } : {}),
        }),
      );
    });
}

request
  .command("ready")
  .description(
    "Hand a request to Brad: ready to review now, or --stage awaiting-release when the work is built and waits for the next release batch",
  )
  .argument("<thread>", "saved agent name or raw thread UUID in the project")
  .argument("<request>", "issue number in the project tracker, owner/repo#N, or issue URL")
  .option("--stage <stage>", "needs-review (default) or awaiting-release", "needs-review")
  .option("--summary <text>", "comment for Brad: the answer, or what to look at and where")
  .action(async (reference, requestReference, options: { stage: string; summary?: string }) => {
    if (options.stage !== "needs-review" && options.stage !== "awaiting-release") {
      throw new Error("--stage must be needs-review or awaiting-release.");
    }
    const { agent: target, client } = await withAgent(reference);
    printJson(
      await client.projectRequest("projectRequestsUpdate", {
        threadId: target.threadId,
        reference: requestReference,
        status: options.stage,
        ...(options.summary ? { comment: options.summary } : {}),
      }),
    );
  });

request
  .command("note")
  .description(
    "Record a short progress line on a request (started, blocked on X, shipped in fork.N); links your thread to it",
  )
  .argument("<thread>", "saved agent name or raw thread UUID in the project")
  .argument("<request>", "issue number in the project tracker, owner/repo#N, or issue URL")
  .argument("<text>", "one short line")
  .action(async (reference, requestReference, text) => {
    const { agent: target, client } = await withAgent(reference);
    printJson(
      await client.projectRequest("projectRequestsUpdate", {
        threadId: target.threadId,
        reference: requestReference,
        comment: `Progress: ${text}`,
      }),
    );
  });

request
  .command("shipped")
  .description(
    "Mark a request as shipped in a release; it waits for Brad's test until he settles it",
  )
  .argument("<thread>", "saved agent name or raw thread UUID in the project")
  .argument("<request>", "issue number in the project tracker, owner/repo#N, or issue URL")
  .requiredOption("--release <tag>", "release it shipped in, for example fork.24 (its milestone)")
  .requiredOption("--test <step>", "one-line test step for Brad")
  .action(async (reference, requestReference, options: { release: string; test: string }) => {
    const { agent: target, client } = await withAgent(reference);
    printJson(
      await client.projectRequest("projectRequestsUpdate", {
        threadId: target.threadId,
        reference: requestReference,
        status: "needs-test",
        release: options.release,
        comment: `Test: ${options.test}`,
      }),
    );
  });

request
  .command("type")
  .description(
    "Set an item's type (ask:question, ask:task or ask:epic, keeping any older ask:* label as history) and its bug tag; works on any tracker issue",
  )
  .argument("<thread>", "saved agent name or raw thread UUID in the project")
  .argument("<request>", "issue number in the project tracker, owner/repo#N, or issue URL")
  .argument("<kind>", "question, task or epic")
  .option("--bug", "tag the item as a bug")
  .option("--no-bug", "remove the bug tag")
  .action(async (reference, requestReference, kind, options: { bug?: boolean }) => {
    assertItemKind(kind);
    const { agent: target, client } = await withAgent(reference);
    printJson(
      await client.projectRequest("projectRequestsUpdate", {
        threadId: target.threadId,
        reference: requestReference,
        kind,
        ...(options.bug === undefined ? {} : { bug: options.bug }),
      }),
    );
  });

request
  .command("title")
  .description(
    'Retitle a task: an imperative for work ("Move the New request box to the top"), the question for a question',
  )
  .argument("<thread>", "saved agent name or raw thread UUID in the project")
  .argument("<request>", "issue number in the project tracker, owner/repo#N, or issue URL")
  .argument("<title>", "the new title")
  .action(async (reference, requestReference, title) => {
    const { agent: target, client } = await withAgent(reference);
    printJson(
      await client.projectRequest("projectRequestsUpdate", {
        threadId: target.threadId,
        reference: requestReference,
        title,
      }),
    );
  });

const dashboard = agent
  .command("dashboard")
  .description("Show or change which widgets a project page shows, in order");

dashboard
  .command("show")
  .argument("<thread>", "saved agent name or raw thread UUID in the project")
  .action(async (reference) => {
    const { agent: target, client } = await withAgent(reference);
    printJson(await client.projectDashboard("projectDashboardGet", { threadId: target.threadId }));
  });

dashboard
  .command("set")
  .argument("<thread>", "saved agent name or raw thread UUID in the project")
  .option(
    "--widgets <ids>",
    "comma-separated widget ids in order, e.g. requests,release,needs-you,working,roadmap,canvas",
  )
  .option("--reset", "restore the default widgets and order")
  .action(async (reference, options: { widgets?: string; reset?: boolean }) => {
    if (!options.reset && !options.widgets) throw new Error("Pass --widgets <ids> or --reset.");
    const { agent: target, client } = await withAgent(reference);
    printJson(
      await client.projectDashboard("projectDashboardSetWidgets", {
        threadId: target.threadId,
        widgets: options.reset
          ? null
          : options
              .widgets!.split(",")
              .map((widget) => widget.trim())
              .filter(Boolean),
      }),
    );
  });

const roadmap = agent
  .command("roadmap")
  .description(
    "The project roadmap: versions are open Gitea milestones on the tracker; the first is the next release",
  );

roadmap
  .command("list")
  .argument("<thread>", "saved agent name or raw thread UUID in the project")
  .action(async (reference) => {
    const { agent: target, client } = await withAgent(reference);
    const plan = await client.projectRoadmap<{
      tracker: { repository: string } | null;
      versions: ReadonlyArray<{ id: number; title: string }>;
      items: ReadonlyArray<{
        number: number;
        title: string;
        stage: string | null;
        versionId: number | null;
        parked: boolean;
      }>;
    }>("projectRoadmapGet", { threadId: target.threadId });
    const column = (versionId: number | null, parked: boolean) =>
      plan.items
        .filter(
          (item) => item.versionId === versionId && (versionId !== null || item.parked === parked),
        )
        .map((item) => ({ number: item.number, title: item.title, stage: item.stage }));
    printJson({
      tracker: plan.tracker?.repository ?? null,
      nextRelease: plan.versions[0]?.title ?? null,
      // Unversioned, not parked: the automatic next version.
      next: column(null, false),
      versions: plan.versions.map((version) => ({
        title: version.title,
        items: column(version.id, false),
      })),
      later: column(null, true),
    });
  });

roadmap
  .command("move")
  .argument("<thread>", "saved agent name or raw thread UUID in the project")
  .argument("<item>", "issue number in the tracker, owner/repo#N, or issue URL")
  .argument(
    "<version>",
    "an open version's title, 'next' for the automatic next version, or 'later' to park it",
  )
  .action(async (reference, item, version) => {
    const { agent: target, client } = await withAgent(reference);
    printJson(
      await client.projectRoadmap("projectRoadmapMove", {
        threadId: target.threadId,
        reference: item,
        ...(version.trim().toLowerCase() === "later"
          ? { version: null, later: true }
          : { version: version.trim().toLowerCase() === "next" ? null : version }),
      }),
    );
  });

roadmap
  .command("version")
  .description("Add a version, or rename one with --id")
  .argument("<thread>", "saved agent name or raw thread UUID in the project")
  .argument("<title>", "version title, for example fork.25")
  .option("--id <milestone>", "existing version id to rename")
  .action(async (reference, title, options: { id?: string }) => {
    const { agent: target, client } = await withAgent(reference);
    printJson(
      await client.projectRoadmap("projectRoadmapSaveVersion", {
        threadId: target.threadId,
        title,
        ...(options.id ? { id: Number(options.id) } : {}),
      }),
    );
  });

const issue = agent.command("issue").description("Manage Gitea issues linked to a thread");

issue
  .command("link")
  .argument("<thread>", "saved agent name or raw thread UUID")
  .argument("<issue>", "owner/repo#N or configured Gitea issue URL")
  .action(async (reference, issueReference) => {
    const { agent: target, client } = await withAgent(reference);
    printJson(await client.linkIssue(target.threadId, issueReference));
  });

issue
  .command("unlink")
  .argument("<thread>", "saved agent name or raw thread UUID")
  .argument("<issue>", "owner/repo#N or configured Gitea issue URL")
  .action(async (reference, issueReference) => {
    const { agent: target, client } = await withAgent(reference);
    printJson(await client.unlinkIssue(target.threadId, issueReference));
  });

agent
  .command("worklog")
  .argument("<name>", "agent name or raw thread UUID")
  .option("--tail <count>", "number of activity rows to show", "10")
  .action(async (name, options) => {
    const { agent: savedAgent, client, saved } = await withAgent(name);
    const thread = await client.getThreadDetail(savedAgent.threadId);
    const tailCount = Math.max(1, Number(options.tail));
    printJson({
      agent: saved ? savedAgent.name : null,
      threadId: savedAgent.threadId,
      environment: savedAgent.environment,
      activities: thread.activities.slice(-tailCount),
    });
  });

agent
  .command("inbox")
  .option("--env <name>", "optional saved environment filter")
  .action(async (options) => {
    const state = await loadState();
    const scopedAgents = options.env
      ? state.agents.filter((agent) => agent.environment === options.env)
      : state.agents;
    const summaries = await Promise.all(
      scopedAgents.map(async (savedAgent) => {
        const environment = requireEnvironment(state, savedAgent.environment);
        const client = new RemoteEnvironmentClient(environment);
        const thread = await client.findThread(savedAgent.threadId);
        return buildAgentOverview(savedAgent, thread);
      }),
    );
    printLines(summaries.filter(needsAttention).map(formatInboxLine));
  });

agent
  .command("implement")
  .description("Implement a Plan Ready proposal in the same thread using build mode")
  .argument("<name>", "agent name or raw thread UUID")
  .option("--plan-id <id>", "implement a specific unimplemented proposed plan")
  .action(async (name, options) => {
    const { agent: savedAgent, client, saved } = await withAgent(name);
    const result = await client.implementPlan({
      threadId: savedAgent.threadId,
      ...(options.planId ? { planId: options.planId } : {}),
    });
    printJson({
      agent: saved ? savedAgent.name : null,
      threadId: result.threadId,
      environment: savedAgent.environment,
      planId: result.planId,
      modeChanged: result.modeChanged,
      dispatched: "implement",
    });
  });

agent
  .command("send")
  .argument("<name>", "agent name or raw thread UUID")
  .argument("<message...>", "message text")
  .option("--no-queue", "fail instead of queueing when the target thread is still running")
  .option(
    "--coalesce <key>",
    "replace your still-queued send to this thread that has the same key instead of queueing behind it",
  )
  .option("--progress", "status note: shorthand for --coalesce progress")
  .action(async (name, messageParts: string[], options: SendCommandOptions) => {
    const rawText = messageParts.join(" ").trim();
    // A name that is neither a saved alias nor a UUID may be a named agent; a
    // dormant one starts with this message, so there is nothing left to send.
    const routingState = await loadState();
    const callerId = resolveCallerThreadId();
    const sender = callerId
      ? await resolveThreadEndpoint(
          routingState,
          callerId,
          undefined,
          resolveCallerEnvironmentMetadata(),
        )
      : null;
    const text = withSenderHeader(
      rawText,
      callerSendOrigin(routingState),
      sender?.environment ?? "unknown",
    );
    const routed = await routeToNamedAgent({
      state: routingState,
      name,
      message: text,
      clientFactory: namedAgentClients(routingState),
    });
    if (routed?.started) {
      printJson({ namedAgent: name, ...routed, dispatched: true, queued: false });
      return;
    }
    const { agent: savedAgent, client, saved } = await withAgent(routed?.threadId ?? name);
    const state = await loadState();
    const outcome = await sendDirectResult({
      callerThreadId: resolveCallerThreadId(),
      subscriberThreadId: savedAgent.threadId,
      getSourceTurn: async (route) =>
        (
          await new RemoteEnvironmentClient(
            requireEnvironment(state, route.sourceEnvironment),
          ).findThread(route.sourceThreadId)
        ).latestTurn?.turnId ?? null,
      send: () =>
        client.sendMessage({
          threadId: savedAgent.threadId,
          text,
          queueWhileRunning: options.queue,
          coalesceKey: options.coalesce ?? (options.progress ? "progress" : null),
          agentName: saved ? savedAgent.name : null,
          origin: callerSendOrigin(state),
          senderEnvironment: sender?.environment,
        }),
    });
    const released = outcome.queued ? [] : await releaseHeldNotifications(savedAgent.threadId);
    if (outcome.queued || released.length > 0) {
      await ensureNotificationWatcher();
    }
    printJson({
      agent: saved ? savedAgent.name : null,
      ...(routed ? { namedAgent: name } : {}),
      threadId: savedAgent.threadId,
      environment: savedAgent.environment,
      ...outcome,
    });
  });

agent
  .command("queue")
  .description("List sends held for threads that were still running")
  .argument("[name]", "agent name or raw thread UUID")
  .option("--env <name>", "optional saved environment filter")
  .option("--open", "only sends that are still waiting to dispatch")
  .option("--summary", "count open sends by target thread and sender instead of listing them")
  .action(async (name: string | undefined, options: QueueCommandOptions) => {
    const threadId = name ? (await withAgent(name)).agent.threadId : undefined;
    const state = await loadState();
    if (options.summary) {
      printJson(
        summarizeQueuedSends(state, {
          ...(options.env ? { env: options.env } : {}),
          ...(threadId ? { threadId } : {}),
        }),
      );
      return;
    }
    printJson(
      listQueuedSends(state, {
        ...(options.env ? { env: options.env } : {}),
        ...(threadId ? { threadId } : {}),
        ...(options.open ? { openOnly: true } : {}),
      }).map((send) => ({
        ...send,
        ageSeconds: Math.max(0, Math.floor((Date.now() - Date.parse(send.queuedAt)) / 1000)),
        actionable: ["queued", "dispatching"].includes(send.status),
      })),
    );
  });

agent
  .command("dequeue")
  .description("Cancel a queued send before it reaches the thread")
  .argument("<id>", "queued send id from `t3-thread queue`")
  .action(async (id: string) => {
    printJson(await cancelQueuedSend(id));
  });

for (const kind of ["clarify", "revise", "complete"] as const) {
  agent
    .command(kind)
    .argument("<name>", "agent name or raw thread UUID")
    .argument("[message...]", "optional follow-up text")
    .action(async (name, messageParts: string[]) => {
      const { agent: savedAgent, client, saved } = await withAgent(name);
      const outcome = await client.sendMessage({
        threadId: savedAgent.threadId,
        text: buildFollowUpMessage(kind, messageParts.join(" ")),
        agentName: saved ? savedAgent.name : null,
        origin: callerSendOrigin(await loadState()),
        senderEnvironment: resolveCallerEndpointFromLocalContext(
          await loadState(),
          resolveCallerThreadId() ?? "",
          resolveCallerEnvironmentMetadata(),
        )?.environment,
      });
      if (outcome.queued) {
        await ensureNotificationWatcher();
      }
      printJson({
        agent: saved ? savedAgent.name : null,
        threadId: savedAgent.threadId,
        environment: savedAgent.environment,
        ...outcome,
        dispatched: outcome.queued ? false : kind,
      });
    });
}

agent
  .command("nest")
  .description("Nest a worker under an orchestrating thread so it leaves the sidebar")
  .argument("<name>", "agent name or raw thread UUID")
  .requiredOption("--parent <agent-or-thread>", "saved agent name or thread UUID to nest under")
  .action(async (name, options) => {
    const { state, agent: savedAgent, client } = await withAgent(name);
    const link = await resolveParentLink(state, options.parent, savedAgent.environment);
    await client.setThreadParent(savedAgent.threadId, link.parentThreadId, link.remoteParent);
    const thread = await client.getThreadDetail(savedAgent.threadId);
    printJson({
      agent: savedAgent.name,
      threadId: savedAgent.threadId,
      parentThreadId: thread.parentThreadId ?? null,
      remoteParent: thread.remoteParent ?? null,
    });
  });

agent
  .command("unnest")
  .description("Move a nested worker back to the sidebar")
  .argument("<name>", "agent name or raw thread UUID")
  .action(async (name) => {
    const { agent: savedAgent, client } = await withAgent(name);
    await client.setThreadParent(savedAgent.threadId, null);
    const thread = await client.getThreadDetail(savedAgent.threadId);
    printJson({
      agent: savedAgent.name,
      threadId: savedAgent.threadId,
      parentThreadId: thread.parentThreadId ?? null,
      remoteParent: thread.remoteParent ?? null,
    });
  });

agent
  .command("pending")
  .description("Show a worker's open questions and approvals")
  .argument("<name>", "agent name or raw thread UUID")
  .action(async (name) => {
    const { agent: savedAgent, client } = await withAgent(name);
    const thread = await client.findThread(savedAgent.threadId);
    printJson({
      agent: savedAgent.name,
      threadId: savedAgent.threadId,
      pending: findPendingRequests(thread.activities),
    });
  });

agent
  .command("answer")
  .description("Answer a worker's oldest open question")
  .argument("<name>", "agent name or raw thread UUID")
  .argument("[text...]", "answer for a single question")
  .option(
    "--question <id=answer>",
    "answer one question by id (repeat for each question)",
    (value: string, previous: string[]) => [...previous, value],
    [] as string[],
  )
  .action(async (name, textParts: string[], options) => {
    const { agent: savedAgent, client } = await withAgent(name);
    const thread = await client.findThread(savedAgent.threadId);
    const request = findPendingRequests(thread.activities).find(
      (pending) => pending.kind === "user-input",
    );
    if (!request || request.kind !== "user-input") {
      throw new Error(`Agent '${savedAgent.name}' has no open question.`);
    }
    const answers = buildUserInputAnswers({
      questions: request.questions,
      text: textParts.join(" "),
      pairs: options.question,
    });
    await client.respondToUserInput({
      threadId: savedAgent.threadId,
      requestId: request.requestId,
      answers,
    });
    printJson({ agent: savedAgent.name, requestId: request.requestId, answered: answers });
  });

for (const [command, description] of [
  ["approve", "Approve a worker's oldest open approval"],
  ["deny", "Decline a worker's oldest open approval"],
] as const) {
  agent
    .command(command)
    .description(description)
    .argument("<name>", "agent name or raw thread UUID")
    .option("--session", "approve similar requests for the rest of the session")
    .action(async (name, options) => {
      const { agent: savedAgent, client } = await withAgent(name);
      const thread = await client.findThread(savedAgent.threadId);
      const request = findPendingRequests(thread.activities).find(
        (pending) => pending.kind === "approval",
      );
      if (!request) throw new Error(`Agent '${savedAgent.name}' has no open approval.`);
      const decision =
        command === "deny" ? "decline" : options.session ? "acceptForSession" : "accept";
      await client.respondToApproval({
        threadId: savedAgent.threadId,
        requestId: request.requestId,
        decision,
      });
      printJson({ agent: savedAgent.name, requestId: request.requestId, decision });
    });
}

agent
  .command("interrupt")
  .argument("<name>", "agent name")
  .action(async (name) => {
    const { agent: savedAgent, client } = await withAgent(name);
    await client.interrupt(savedAgent.threadId);
    printJson({
      agent: savedAgent.name,
      threadId: savedAgent.threadId,
      interrupted: true,
    });
  });

agent
  .command("wait")
  .argument("<name>", "agent name or raw thread UUID")
  .option("--for <goal>", "completion|attention|idle|running", "completion")
  .option("--timeout <seconds>", "timeout in seconds", "300")
  .option("--interval <seconds>", "poll interval in seconds", "5")
  .action(async (name, options) => {
    const { agent: savedAgent, client, saved } = await withAgent(name);
    const thread = await client.waitForThread({
      threadId: savedAgent.threadId,
      goal: options.for,
      timeoutMs: Number(options.timeout) * 1000,
      intervalMs: Number(options.interval) * 1000,
    });
    const status = classifyThread(thread);
    printJson({
      agent: saved ? savedAgent.name : null,
      threadId: savedAgent.threadId,
      environment: savedAgent.environment,
      state: status.state,
      reason: status.reason,
      latestTurn: thread.latestTurn,
    });
  });

agent
  .command("result")
  .argument("<name>", "agent name or raw thread UUID")
  .option("--tail <count>", "number of messages to show", "1")
  .option("--assistant-only", "only show assistant messages")
  .option(
    "--wait <seconds>",
    "wait up to this many seconds for the latest turn to complete before reading",
  )
  .option("--interval <seconds>", "poll interval in seconds while waiting", "2")
  .option(
    "--final-message",
    "return the terminal assistant message for the latest turn when available",
  )
  .option("--mark-seen", "record the latest assistant message as reviewed")
  .action(async (name, options) => {
    const { agent: savedAgent, client, saved, target } = await withAgent(name);
    const detail = options.wait
      ? await client.waitForThread({
          threadId: savedAgent.threadId,
          goal: "completion",
          timeoutMs: Number(options.wait) * 1000,
          intervalMs: Number(options.interval) * 1000,
        })
      : await client.getThreadDetail(savedAgent.threadId);
    const tailCount = Math.max(1, Number(options.tail));
    const latestAssistant = options.finalMessage
      ? (getLatestTurnAssistantMessage(detail) ?? getLatestAssistantMessage(detail))
      : getLatestAssistantMessage(detail);
    const messages = options.finalMessage
      ? latestAssistant
        ? [latestAssistant]
        : []
      : options.assistantOnly
        ? detail.messages.filter((message) => message.role === "assistant")
        : detail.messages;
    if (options.markSeen) {
      assertSavedAgentCapability(target, "`result --mark-seen`");
    }
    let markedSeen = false;
    if (options.markSeen && latestAssistant) {
      await updateState(async (state) => {
        const currentAgent = requireAgent(state, savedAgent.name);
        return {
          state: {
            ...state,
            agents: upsertAgent(state.agents, {
              ...currentAgent,
              lastSeenAssistantMessageId: latestAssistant.id,
            }),
          },
          result: null,
        };
      });
      markedSeen = true;
    }
    printJson({
      agent: saved ? savedAgent.name : null,
      threadId: savedAgent.threadId,
      environment: savedAgent.environment,
      saved,
      hasNewOutput: saved ? hasNewAssistantOutput(savedAgent, detail) : null,
      latestAssistantMessageId: latestAssistant?.id ?? null,
      latestTurnAssistantMessageId: detail.latestTurn?.assistantMessageId ?? null,
      markedSeen,
      messages: messages.slice(-tailCount),
    });
  });

agent
  .command("ack")
  .argument("<name>", "agent name")
  .action(async (name) => {
    const { agent: savedAgent, client } = await withAgent(name);
    const detail = await client.getThreadDetail(savedAgent.threadId);
    const latestAssistant = getLatestAssistantMessage(detail);
    if (!latestAssistant) {
      throw new Error(`Agent '${savedAgent.name}' has no assistant message to acknowledge.`);
    }
    await updateState(async (state) => {
      const currentAgent = requireAgent(state, savedAgent.name);
      return {
        state: {
          ...state,
          agents: upsertAgent(state.agents, {
            ...currentAgent,
            lastSeenAssistantMessageId: latestAssistant.id,
          }),
        },
        result: null,
      };
    });
    printJson({
      agent: savedAgent.name,
      threadId: savedAgent.threadId,
      lastSeenAssistantMessageId: latestAssistant.id,
    });
  });

/** Named-agent clients for the environments saved in `state`. */
function namedAgentClients(state: Awaited<ReturnType<typeof loadState>>) {
  return (environment: string) =>
    new RemoteEnvironmentClient(requireEnvironment(state, environment));
}

const namedAgentsCommand = program
  .command("agents")
  .description("Named agents: one owner per resource, each with one live thread");

namedAgentsCommand
  .command("list", { isDefault: true })
  .description("List named agents with scope, live thread and status")
  .option("--env <name>", "only this saved environment")
  .action(async (options: { env?: string }) => {
    const state = await loadState();
    printJson(
      await listNamedAgents({
        state,
        clientFactory: namedAgentClients(state),
        ...(options.env ? { environment: options.env } : {}),
      }),
    );
  });

namedAgentsCommand
  .command("add")
  .description("Make a folder the home of a named agent (its project is created if missing)")
  .argument("<name>", "agent name: lowercase letters, digits and hyphens")
  .requiredOption("--env <name>", "saved environment that can reach the resource")
  .requiredOption(
    "--path <folder>",
    "agent folder on that environment, e.g. ~/.shared/agents/<name>",
  )
  .option("--scope <text>", "one-line scope; also writes starter AGENT.md/BRIEFING.md if missing")
  .action(async (name: string, options: { env: string; path: string; scope?: string }) => {
    if (!/^[a-z][a-z0-9-]{0,47}$/.test(name)) {
      throw new Error(
        "Agent names use lowercase letters, digits and hyphens, starting with a letter.",
      );
    }
    const state = await loadState();
    const client = new RemoteEnvironmentClient(requireEnvironment(state, options.env));
    const scaffolded = options.scope
      ? scaffoldAgentFolder({
          folder: options.path,
          name,
          scope: options.scope,
          environment: options.env,
        })
      : [];
    const existing = (await client.listProjects()).find(
      (project) => project.workspaceRoot === options.path,
    );
    const project =
      existing ?? (await client.createProject({ workspaceRoot: options.path, title: name }));
    await client.setPermanentAgent(project.id, name);
    printJson({
      name,
      environment: options.env,
      projectId: project.id,
      folder: options.path,
      scaffolded,
    });
  });

namedAgentsCommand
  .command("handover")
  .description(
    "Start a fresh incarnation from AGENT.md and BRIEFING.md, archiving the idle current one",
  )
  .argument("<name>", "named agent")
  .argument("[message...]", "optional first request for the new incarnation")
  .action(async (name: string, messageParts: string[]) => {
    const state = await loadState();
    const { agents } = await listNamedAgents({ state, clientFactory: namedAgentClients(state) });
    const owners = agents.filter((agent) => agent.name === name);
    if (owners.length !== 1) {
      throw new Error(
        owners.length === 0
          ? `No named agent '${name}' on any reachable paired environment.`
          : `Named agent '${name}' exists in several environments: ${owners.map((owner) => owner.environment).join(", ")}.`,
      );
    }
    const environment = owners[0]!.environment;
    const message = messageParts.join(" ").trim();
    const result = await new RemoteEnvironmentClient(
      requireEnvironment(state, environment),
    ).handOverNamedAgent(name, message.length > 0 ? message : undefined);
    printJson({
      namedAgent: name,
      environment,
      previousThreadId: owners[0]!.liveThreadId,
      ...result,
    });
  });

registerAutomationCommands(program);

program.parseAsync(process.argv).catch((error) => {
  process.stderr.write(`${formatCliError(error)}\n`);
  process.exitCode = 1;
});
