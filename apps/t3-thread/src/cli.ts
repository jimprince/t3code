#!/usr/bin/env node

import { Command } from "commander";

import { assertSavedAgentCapability, resolveAgentTarget } from "./agent-targets.js";
import { buildFollowUpMessage } from "./agentPrompts.js";
import { RemoteEnvironmentClient } from "./client.js";
import { resolvePairingTarget } from "./http.js";
import {
  buildAgentOverview,
  getLatestTurnAssistantMessage,
  formatInboxLine,
  formatOverviewLine,
  getLatestAssistantMessage,
  hasNewAssistantOutput,
  needsAttention,
  summarizeMessageText,
} from "./monitor.js";
import { classifyThread, formatThreadLine } from "./status.js";
import {
  assertNotSelfSubscription,
  buildSubscriptionRecord,
  loadState,
  requireAgent,
  requireEnvironment,
  removeAgent,
  removeSubscription,
  resolveCallerEndpointFromLocalContext,
  resolveCallerEnvironmentMetadata,
  resolveCallerThreadId,
  resolveNotifyPreference,
  updateState,
  upsertAgent,
  upsertSubscription,
  upsertEnvironment,
} from "./state.js";
import { wrapWithPreamble } from "./thread-preamble.js";
import { claimWatcherLease, ensureWatcherProcess } from "./watcher-process.js";
import { deliverPendingNotifications, detectAttentionEvents, hasWatcherWork } from "./watch.js";
import type { CallerEnvironmentMetadata, SubscriptionEndpoint } from "./state.js";
import type { SavedAgent } from "./types.js";

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
): Promise<SubscriptionEndpoint | null> {
  const callerEnvironment = resolveCallerEnvironmentMetadata();
  const preference = resolveNotifyPreference(notify);

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
  "attach",
  "list",
  "archive",
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
  "clarify",
  "revise",
  "complete",
  "interrupt",
  "wait",
  "result",
  "ack",
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
    printJson({
      name: paired.name,
      environmentId: paired.environmentId,
      label: paired.label,
      httpBaseUrl: paired.httpBaseUrl,
      expiresAt: paired.expiresAt,
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
  .description("List remote thread shells without loading full thread history")
  .action(async (options) => {
    const state = await loadState();
    const environment = requireEnvironment(state, options.env);
    const client = new RemoteEnvironmentClient(environment);
    const threads = await client.listThreads();
    printLines(threads.map(formatThreadLine));
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

const project = program.command("project").description("Manage T3 Code projects");

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
  .action(async (options) => {
    const state = await loadState();
    const environment = requireEnvironment(state, options.env);
    const notifyCaller = await resolveNotifyEndpoint(state, options.notify, options.env);
    if (options.worktree) {
      throw new Error(
        "`--worktree` is no longer supported by agent create. T3 chooses the worktree path; use `--branch` and `--base-branch` only.",
      );
    }
    const client = new RemoteEnvironmentClient(environment);
    // `options.preamble` is false only when `--no-preamble` was passed (Commander convention).
    const initialMessage =
      options.preamble === false ? options.message : wrapWithPreamble(options.message);
    const created = await client.createAgentThread({
      projectId: options.project,
      title: options.title,
      provider: options.provider,
      model: options.model,
      branch: options.branch,
      baseBranch: options.baseBranch,
      runtimeMode: options.runtimeMode,
      interactionMode: options.interactionMode,
      initialMessage,
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
          buildSubscriptionRecord(notifyCaller, savedAgent, createdAt, existing),
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
      notifySubscriberAgentName: notifyCaller?.name ?? null,
      notifySubscriberThreadId: notifyCaller?.threadId ?? null,
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
  .option("--subscriber <name>", "filter by subscriber agent name")
  .option("--source <name>", "filter by source agent name")
  .action(async (options) => {
    const state = await loadState();
    const subscriptions = state.subscriptions.filter((subscription) => {
      if (options.subscriber && subscription.subscriberAgentName !== options.subscriber) {
        return false;
      }
      if (options.source && subscription.sourceAgentName !== options.source) {
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
    const existing = state.subscriptions.find(
      (subscription) =>
        subscription.subscriberThreadId === caller.threadId &&
        subscription.sourceThreadId === source.threadId,
    );
    const next = buildSubscriptionRecord(caller, source, now, existing);
    await updateState(async (currentState) => ({
      state: {
        ...currentState,
        subscriptions: upsertSubscription(currentState.subscriptions, next),
      },
      result: null,
    }));
    void ensureNotificationWatcher({ env: source.environment }).catch(() => {});
    printJson(next);
  });

agent
  .command("unsubscribe")
  .description("Remove an attention subscription for the calling T3 thread")
  .requiredOption("--watch <name>", "saved source agent name to stop watching")
  .action(async (options) => {
    const { state, caller } = await withCallerFromEnv();
    const source = requireAgent(state, options.watch);
    const nextSubscriptions = removeSubscription(state.subscriptions, {
      subscriberThreadId: caller.threadId,
      sourceThreadId: source.threadId,
    });
    const removed = nextSubscriptions.length !== state.subscriptions.length;
    await updateState(async (currentState) => ({
      state: {
        ...currentState,
        subscriptions: removeSubscription(currentState.subscriptions, {
          subscriberThreadId: caller.threadId,
          sourceThreadId: source.threadId,
        }),
      },
      result: null,
    }));
    printJson({
      removed,
      subscriberAgentName: caller.name,
      sourceAgentName: source.name,
      subscriberThreadId: caller.threadId,
      sourceThreadId: source.threadId,
    });
  });

agent
  .command("notifications")
  .description("List saved routed notification events")
  .option("--subscriber <name>", "filter by subscriber agent name")
  .option("--source <name>", "filter by source agent name")
  .option("--status <status>", "filter by notification status")
  .action(async (options) => {
    const state = await loadState();
    const notifications = state.notifications.filter((notification) => {
      if (options.subscriber && notification.subscriberAgentName !== options.subscriber) {
        return false;
      }
      if (options.source && notification.sourceAgentName !== options.source) {
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

    try {
      for (;;) {
        const detectedNotifications = await detectAttentionEvents({
          env: options.env,
        });
        const deliveryResults = options.deliver
          ? await deliverPendingNotifications({
              env: options.env,
            })
          : [];
        const workRemaining = await hasWatcherWork({
          env: options.env,
        });
        printJson({
          scannedAt: nowIso(),
          env: options.env ?? null,
          deliver: options.deliver,
          detectedNotifications,
          deliveryResults,
          workRemaining,
        });

        if (options.once) {
          break;
        }

        const nowMs = Date.now();
        if (maxLifetimeMs > 0 && nowMs - startedAt >= maxLifetimeMs) {
          break;
        }

        if (workRemaining) {
          idleSince = 0;
        } else if (idleExitMs > 0) {
          idleSince ||= nowMs;
          if (nowMs - idleSince >= idleExitMs) {
            break;
          }
        }

        await sleep(intervalMs);
      }
    } finally {
      await releaseLease?.();
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
          const environment = requireEnvironment(state, savedAgent.environment);
          const client = new RemoteEnvironmentClient(environment);
          const thread = await client.findThread(savedAgent.threadId);
          return buildAgentOverview(savedAgent, thread);
        }),
      );
      printLines(summaries.map(formatOverviewLine));
      return;
    }

    const { agent: savedAgent, client, saved } = await withAgent(name);
    const thread = await client.findThread(savedAgent.threadId);
    const status = classifyThread(thread);
    const latestAssistant = getLatestAssistantMessage(thread);
    printJson({
      agent: saved ? savedAgent.name : null,
      environment: savedAgent.environment,
      threadId: savedAgent.threadId,
      title: savedAgent.title,
      projectId: savedAgent.projectId,
      saved,
      state: status.state,
      reason: status.reason,
      latestTurn: thread.latestTurn,
      session: thread.session,
      proposedPlans: thread.proposedPlans.length,
      messageCount: thread.messages.length,
      hasNewOutput: saved ? hasNewAssistantOutput(savedAgent, thread) : null,
      latestAssistantMessageId: latestAssistant?.id ?? null,
      latestAssistantPreview: latestAssistant ? summarizeMessageText(latestAssistant.text) : null,
    });
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
  .action(async (name, messageParts: string[]) => {
    const { agent: savedAgent, client, saved } = await withAgent(name);
    await client.sendMessage({
      threadId: savedAgent.threadId,
      text: messageParts.join(" ").trim(),
    });
    printJson({
      agent: saved ? savedAgent.name : null,
      threadId: savedAgent.threadId,
      environment: savedAgent.environment,
      dispatched: true,
    });
  });

for (const kind of ["clarify", "revise", "complete"] as const) {
  agent
    .command(kind)
    .argument("<name>", "agent name or raw thread UUID")
    .argument("[message...]", "optional follow-up text")
    .action(async (name, messageParts: string[]) => {
      const { agent: savedAgent, client, saved } = await withAgent(name);
      await client.sendMessage({
        threadId: savedAgent.threadId,
        text: buildFollowUpMessage(kind, messageParts.join(" ")),
      });
      printJson({
        agent: saved ? savedAgent.name : null,
        threadId: savedAgent.threadId,
        environment: savedAgent.environment,
        dispatched: kind,
      });
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

program.parseAsync(process.argv).catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
