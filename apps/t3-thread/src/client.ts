import { wrapWithPreamble, type WorkerContext } from "./thread-preamble.js";
import { withSenderHeader } from "./thread-identity.js";
import type { ProjectAutomation } from "@t3tools/contracts";
import type { NamedAgentSummary } from "./namedAgents.js";
import { makeMessageOriginContext, type MessageOrigin } from "@t3tools/shared/messageOrigin";
import * as NodeCrypto from "node:crypto";

import {
  buildModelSelection,
  buildProjectCreateCommand,
  buildProjectDeleteCommand,
  buildProjectMetaUpdateCommand,
  deriveProjectTitle,
  findExistingProjectByPath,
  listThreadsForProject,
  resolveProjectTarget,
} from "./projects.js";
import type { ProviderModelInventory } from "./projects.js";
import {
  exchangePairingCredential,
  fetchEnvironmentDescriptor,
  fetchSessionState,
  resolveWebSocketUrl,
} from "./http.js";
import { T3RpcClient } from "./rpc.js";
import { enqueueSend } from "./sendQueue.js";
import { classifyThread } from "./status.js";
import { resolveCallerThreadId } from "./state.js";
import { refreshSavedEnvironmentSession } from "./sessionRefresh.js";
import type {
  ExecutionEnvironmentDescriptor,
  ModelSelection,
  OrchestrationProposedPlan,
  OrchestrationProjectShell,
  OrchestrationShellSnapshot,
  OrchestrationThread,
  OrchestrationThreadShell,
  ThreadIssueLink,
  SavedEnvironment,
} from "./types.js";
import type { ServerConfig, ServerProvider } from "./contracts.js";

const DEFAULT_MODEL_SELECTION: ModelSelection = {
  provider: "codex",
  model: "gpt-5.4",
};

type RemoteRpcClient = Pick<
  T3RpcClient,
  "request" | "subscribeShellSnapshot" | "subscribeThreadSnapshot" | "dispose"
>;

type RpcFactory = (wsUrl: string) => RemoteRpcClient;

/** Result of `RemoteEnvironmentClient.sendMessage`. Exactly one of the two shapes. */
export type SendMessageOutcome =
  | { dispatched: true; queued: false }
  | { dispatched: false; queued: true; queuedSendId: string; sequence: number };

function buildPlanImplementationPrompt(planMarkdown: string): string {
  return `PLEASE IMPLEMENT THIS PLAN:\n${planMarkdown.trim()}`;
}

function newestPlan(plans: readonly OrchestrationProposedPlan[]): OrchestrationProposedPlan | null {
  return (
    [...plans]
      .sort(
        (left, right) =>
          left.updatedAt.localeCompare(right.updatedAt) || left.id.localeCompare(right.id),
      )
      .at(-1) ?? null
  );
}

function selectPlanForImplementation(
  thread: OrchestrationThread,
  planId?: string,
): OrchestrationProposedPlan {
  if (planId) {
    const plan = thread.proposedPlans.find((candidate) => candidate.id === planId);
    if (!plan) {
      throw new Error(`Thread '${thread.id}' has no proposed plan '${planId}'.`);
    }
    if (plan.implementedAt) {
      throw new Error(`Proposed plan '${plan.id}' is already implemented.`);
    }
    return plan;
  }

  const latestTurnId = thread.latestTurn?.turnId;
  const plan =
    (latestTurnId
      ? newestPlan(thread.proposedPlans.filter((candidate) => candidate.turnId === latestTurnId))
      : null) ?? newestPlan(thread.proposedPlans);
  if (!plan) {
    throw new Error(`Thread '${thread.id}' has no proposed plan to implement.`);
  }
  if (plan.implementedAt) {
    throw new Error(`Proposed plan '${plan.id}' is already implemented.`);
  }
  return plan;
}

function threadHasActiveTurn(thread: OrchestrationThread): boolean {
  return (
    thread.latestTurn?.state === "running" ||
    thread.session?.status === "starting" ||
    thread.session?.status === "running" ||
    (thread.session?.activeTurnId ?? null) !== null
  );
}

function nowIso(): string {
  return new Date().toISOString();
}

function providerIdFromSnapshot(provider: ServerProvider): string | null {
  return provider.instanceId ?? provider.provider ?? provider.driver ?? null;
}

function providerInventoryFromConfig(config: ServerConfig): ProviderModelInventory[] {
  return config.providers.flatMap((provider) => {
    const providerId = providerIdFromSnapshot(provider);
    if (!providerId) {
      return [];
    }
    return [
      {
        provider: providerId,
        ...(provider.displayName ? { displayName: provider.displayName } : {}),
        ...(provider.driver ? { driver: provider.driver } : {}),
        enabled: provider.enabled,
        installed: provider.installed,
        status: provider.status,
        models: provider.models.map((model) => ({
          slug: model.slug,
          name: model.name,
          ...(model.shortName ? { shortName: model.shortName } : {}),
          isCustom: model.isCustom,
        })),
      },
    ];
  });
}

export class RemoteEnvironmentClient {
  private currentEnvironment: SavedEnvironment;
  private readonly rpcFactory: RpcFactory | null;

  constructor(environment: SavedEnvironment, options: { rpcFactory?: RpcFactory } = {}) {
    this.currentEnvironment = environment;
    this.rpcFactory = options.rpcFactory ?? null;
  }

  get environment(): SavedEnvironment {
    return this.currentEnvironment;
  }

  static async pair(input: {
    name: string;
    httpBaseUrl: string;
    wsBaseUrl: string;
    credential: string;
  }): Promise<SavedEnvironment> {
    const [descriptor, exchange] = await Promise.all([
      fetchEnvironmentDescriptor(input.httpBaseUrl),
      exchangePairingCredential({
        httpBaseUrl: input.httpBaseUrl,
        credential: input.credential,
        clientLabel: `t3-thread:${input.name}`,
      }),
    ]);

    const session = await fetchSessionState({
      httpBaseUrl: input.httpBaseUrl,
      bearerToken: exchange.access_token,
    });

    if (!session.authenticated) {
      throw new Error("Remote environment did not authenticate the exchanged access token.");
    }

    const expiresAt = new Date(Date.now() + Math.max(0, exchange.expires_in) * 1000).toISOString();

    return {
      name: input.name,
      httpBaseUrl: input.httpBaseUrl,
      wsBaseUrl: input.wsBaseUrl,
      environmentId: descriptor.environmentId,
      label: descriptor.label,
      serverVersion: descriptor.serverVersion,
      bearerToken: exchange.access_token,
      expiresAt,
      pairedAt: nowIso(),
    };
  }

  async describe(): Promise<ExecutionEnvironmentDescriptor> {
    await this.refreshEnvironment();
    return fetchEnvironmentDescriptor(this.environment.httpBaseUrl);
  }

  async getServerConfig(): Promise<ServerConfig> {
    const rpc = await this.openRpc();
    try {
      return await rpc.request<ServerConfig>("serverGetConfig", {});
    } finally {
      await rpc.dispose();
    }
  }

  async listModels(): Promise<ProviderModelInventory[]> {
    return providerInventoryFromConfig(await this.getServerConfig());
  }

  private async getProviderModelsOrNull(): Promise<ProviderModelInventory[] | null> {
    try {
      return await this.listModels();
    } catch {
      return null;
    }
  }

  async getShellSnapshot(): Promise<{
    projects: OrchestrationProjectShell[];
    threads: OrchestrationThreadShell[];
  }> {
    const rpc = await this.openRpc();
    try {
      const item = await rpc.subscribeShellSnapshot<{
        kind: "snapshot";
        snapshot: OrchestrationShellSnapshot;
      }>();
      if (item.kind !== "snapshot") {
        throw new Error(`Expected an orchestration shell snapshot, received '${item.kind}'.`);
      }
      return {
        projects: item.snapshot.projects,
        threads: item.snapshot.threads,
      };
    } finally {
      await rpc.dispose();
    }
  }

  async getThreadDetail(threadId: string): Promise<OrchestrationThread> {
    return this.findThread(threadId);
  }

  async listThreads(): Promise<OrchestrationThreadShell[]> {
    const snapshot = await this.getShellSnapshot();
    return snapshot.threads;
  }

  async listAutomations(projectId: string): Promise<readonly ProjectAutomation[]> {
    const project = (await this.listProjects()).find((entry) => entry.id === projectId);
    if (!project) throw new Error("Project does not exist on this environment.");
    return project.automations ?? [];
  }

  async dispatchAutomation(command: {
    type: string;
    projectId: string;
    commandId: string;
    automation?: unknown;
    automationId?: string;
  }): Promise<readonly ProjectAutomation[]> {
    await this.listAutomations(command.projectId);
    const rpc = await this.openRpc();
    try {
      await rpc.request("dispatchCommand", command);
    } finally {
      await rpc.dispose();
    }
    return this.listAutomations(command.projectId);
  }

  async listWorktreeGcThreads(): Promise<OrchestrationThreadShell[]> {
    const rpc = await this.openRpc();
    try {
      const archived = await rpc.request<OrchestrationShellSnapshot>(
        "getArchivedShellSnapshot",
        {},
      );
      // Read active threads last so a just-unarchived thread vetoes retirement.
      const active = await this.listThreads();
      return [...archived.threads, ...active];
    } finally {
      await rpc.dispose();
    }
  }

  async listProjects(): Promise<OrchestrationProjectShell[]> {
    const snapshot = await this.getShellSnapshot();
    return snapshot.projects;
  }

  async createProject(input: {
    workspaceRoot: string;
    title?: string;
    provider?: string;
    model?: string;
    modelOptionEntries?: string[];
    noDefaultModel?: boolean;
    createDir?: boolean;
  }): Promise<OrchestrationProjectShell> {
    const snapshot = await this.getShellSnapshot();
    const existingProject = findExistingProjectByPath(snapshot.projects, input.workspaceRoot);
    if (existingProject) {
      throw new Error(
        `An active project already exists for '${existingProject.workspaceRoot}' (${existingProject.id}).`,
      );
    }

    const projectId = NodeCrypto.randomUUID();
    const title = deriveProjectTitle(input.workspaceRoot, input.title);
    const providerModels = input.noDefaultModel ? null : await this.getProviderModelsOrNull();
    const defaultModelSelection = buildModelSelection({
      provider: input.provider,
      model: input.model,
      optionEntries: input.modelOptionEntries,
      noDefault: input.noDefaultModel,
      providerModels,
    });
    const command = buildProjectCreateCommand({
      commandId: NodeCrypto.randomUUID(),
      projectId,
      title,
      workspaceRoot: input.workspaceRoot,
      createWorkspaceRootIfMissing: input.createDir,
      defaultModelSelection,
      createdAt: nowIso(),
    });

    const rpc = await this.openRpc();
    try {
      await rpc.request("dispatchCommand", command);
    } finally {
      await rpc.dispose();
    }

    return {
      id: projectId,
      title,
      workspaceRoot: command.workspaceRoot,
      defaultModelSelection,
    };
  }

  async renameProject(input: {
    identifier: string;
    title: string;
  }): Promise<OrchestrationProjectShell> {
    const snapshot = await this.getShellSnapshot();
    const project = resolveProjectTarget(snapshot.projects, input.identifier);
    const command = buildProjectMetaUpdateCommand({
      commandId: NodeCrypto.randomUUID(),
      projectId: project.id,
      title: input.title,
    });

    const rpc = await this.openRpc();
    try {
      await rpc.request("dispatchCommand", command);
    } finally {
      await rpc.dispose();
    }

    return {
      ...project,
      title: command.title ?? project.title,
    };
  }

  async setProjectDefaultModel(input: {
    identifier: string;
    provider?: string;
    model?: string;
    modelOptionEntries?: string[];
    clear?: boolean;
  }): Promise<OrchestrationProjectShell> {
    const snapshot = await this.getShellSnapshot();
    const project = resolveProjectTarget(snapshot.projects, input.identifier);
    const providerModels = input.clear ? null : await this.getProviderModelsOrNull();
    const defaultModelSelection = buildModelSelection({
      provider: input.provider,
      model: input.model,
      optionEntries: input.modelOptionEntries,
      clear: input.clear,
      providerModels,
    });
    const command = buildProjectMetaUpdateCommand({
      commandId: NodeCrypto.randomUUID(),
      projectId: project.id,
      defaultModelSelection,
    });

    const rpc = await this.openRpc();
    try {
      await rpc.request("dispatchCommand", command);
    } finally {
      await rpc.dispose();
    }

    return {
      ...project,
      defaultModelSelection: command.defaultModelSelection ?? null,
    };
  }

  async removeProject(input: { identifier: string; force?: boolean }): Promise<{
    project: OrchestrationProjectShell;
    activeThreadCount: number;
    removed: true;
  }> {
    const snapshot = await this.getShellSnapshot();
    const project = resolveProjectTarget(snapshot.projects, input.identifier);
    const activeThreads = listThreadsForProject(snapshot.threads, project.id);
    if (activeThreads.length > 0 && !input.force) {
      throw new Error(
        `Project '${project.id}' has ${activeThreads.length} active thread(s). Re-run with --force to remove the project and its threads.`,
      );
    }
    const command = buildProjectDeleteCommand({
      commandId: NodeCrypto.randomUUID(),
      projectId: project.id,
      force: input.force,
    });

    const rpc = await this.openRpc();
    try {
      await rpc.request("dispatchCommand", command);
    } finally {
      await rpc.dispose();
    }

    return {
      project,
      activeThreadCount: activeThreads.length,
      removed: true,
    };
  }

  async findThread(threadId: string): Promise<OrchestrationThread> {
    const rpc = await this.openRpc();
    try {
      const item = await rpc.subscribeThreadSnapshot<{
        kind: "snapshot";
        snapshot: {
          snapshotSequence: number;
          thread: OrchestrationThread;
        };
      }>(threadId);
      if (item.kind !== "snapshot") {
        throw new Error(`Expected a thread snapshot for '${threadId}', received '${item.kind}'.`);
      }
      return item.snapshot.thread;
    } finally {
      await rpc.dispose();
    }
  }

  async renameThread(input: {
    threadId: string;
    title?: string;
    scope?: string | null;
  }): Promise<{ threadId: string; title: string; scope: string | null }> {
    const title = input.title?.trim();
    const scope = input.scope === undefined ? undefined : input.scope?.trim() || null;
    if (input.title !== undefined && !title) throw new Error("Thread title must not be empty.");
    if (title === undefined && scope === undefined) {
      throw new Error("Thread title or scope must be provided.");
    }
    const rpc = await this.openRpc();
    try {
      await rpc.request("dispatchCommand", {
        type: "thread.meta.update",
        commandId: NodeCrypto.randomUUID(),
        threadId: input.threadId,
        ...(title !== undefined ? { title } : {}),
        ...(scope !== undefined ? { scope } : {}),
      });
    } finally {
      await rpc.dispose();
    }
    const thread = await this.findThread(input.threadId);
    if (title !== undefined && thread.title !== title)
      throw new Error("Thread title readback did not match the requested title.");
    if (scope !== undefined && (thread.scope ?? null) !== scope) {
      throw new Error("Thread scope readback did not match the requested scope.");
    }
    return { threadId: thread.id, title: thread.title, scope: thread.scope ?? null };
  }

  async createAgentThread(input: {
    projectId: string;
    title: string;
    provider?: string;
    model?: string;
    runtimeMode?: string;
    interactionMode?: string;
    branch?: string;
    baseBranch?: string;
    startFromOrigin?: boolean;
    initialMessage?: string;
    workerContext?: WorkerContext;
    parentThreadId?: string | null;
    settleOnComplete?: boolean;
    pin?: boolean;
  }): Promise<{ threadId: string; projectId: string; title: string; pinned: boolean }> {
    const snapshot = await this.getShellSnapshot();
    const project = snapshot.projects.find((candidate) => candidate.id === input.projectId);
    if (!project) {
      throw new Error(`Project '${input.projectId}' was not found in '${this.environment.name}'.`);
    }
    const title = input.title.trim();
    if (!title) throw new Error("Thread title must not be empty.");
    const initialMessage = input.initialMessage?.trim();
    if (!initialMessage) {
      throw new Error("agent create requires a non-empty initial message.");
    }

    const providerModels = await this.getProviderModelsOrNull();
    const modelSelection =
      input.model || input.provider
        ? (buildModelSelection({
            provider: input.provider,
            model: input.model,
            providerModels,
          }) ?? DEFAULT_MODEL_SELECTION)
        : (project.defaultModelSelection ??
          buildModelSelection({ providerModels }) ??
          DEFAULT_MODEL_SELECTION);

    const config = await this.getServerConfig().catch(() => null);
    const settleOnComplete =
      input.settleOnComplete ??
      config?.settings.projectSettingsOverrides[project.id]?.subthreadSettleOnComplete ??
      config?.settings.subthreadSettleOnComplete ??
      true;
    const threadId = NodeCrypto.randomUUID();
    const runtimeMode = input.runtimeMode ?? "full-access";
    const interactionMode = input.interactionMode ?? "default";
    const createdAt = nowIso();
    const rpc = await this.openRpc();
    try {
      await rpc.request("dispatchCommand", {
        type: "thread.turn.start",
        commandId: NodeCrypto.randomUUID(),
        threadId,
        message: {
          messageId: NodeCrypto.randomUUID(),
          role: "user",
          text: input.workerContext
            ? wrapWithPreamble(initialMessage, {
                ...input.workerContext,
                threadId,
                environment: this.environment.name,
                projectId: project.id,
                projectTitle: project.title,
                branch: input.branch ?? null,
                worktreePath: input.branch ? null : project.workspaceRoot,
                createdAt,
              })
            : initialMessage,
          attachments: [],
        },
        modelSelection,
        titleSeed: title,
        runtimeMode,
        interactionMode,
        bootstrap: {
          createThread: {
            lockTitle: true,
            projectId: project.id,
            title,
            modelSelection,
            runtimeMode,
            interactionMode,
            branch: null,
            worktreePath: null,
            createdAt,
            settleOnComplete,
            ...(input.parentThreadId ? { parentThreadId: input.parentThreadId } : {}),
          },
          ...(input.branch
            ? {
                prepareWorktree: {
                  projectCwd: project.workspaceRoot,
                  baseBranch: input.baseBranch ?? "main",
                  branch: input.branch,
                  // The wire key is retained for server compatibility. Its
                  // current meaning is remote-based creation (gitea, then origin).
                  startFromOrigin: input.startFromOrigin ?? true,
                },
                runSetupScript: true,
              }
            : {}),
        },
        createdAt,
      });
    } finally {
      await rpc.dispose();
    }

    const pinState = input.pin ? await this.setThreadPinned(threadId, true) : null;
    return {
      threadId,
      projectId: project.id,
      title,
      pinned: pinState?.pinned ?? false,
    };
  }

  /**
   * Send a follow-up message to a thread.
   *
   * A send to a thread whose turn is still running is *accepted and queued* rather
   * than rejected: it is held in durable local state and dispatched by the watcher
   * at the next turn boundary (see `sendQueue.ts`). The caller is told which
   * happened so it is never misled into thinking the worker has already seen it.
   *
   * - `allowWhileRunning` forces a concurrent dispatch (steering); it never queues.
   * - `queueWhileRunning: false` restores the historical hard rejection for callers
   *   that need a mid-turn send to fail loudly instead of being held.
   */
  async sendMessage(input: {
    threadId: string;
    text: string;
    allowWhileRunning?: boolean;
    queueWhileRunning?: boolean;
    agentName?: string | null;
    /** Marks the message as sent on a thread's behalf; see `@t3tools/shared/messageOrigin`. */
    origin?: MessageOrigin | null;
    senderEnvironment?: string;
  }): Promise<SendMessageOutcome> {
    const thread = await this.findThread(input.threadId);
    if (thread.archivedAt || thread.deletedAt) {
      throw new Error(`Thread '${thread.id}' is archived and cannot receive messages.`);
    }

    const text = withSenderHeader(input.text, input.origin, input.senderEnvironment ?? "unknown");
    const status = classifyThread(thread);
    if (status.state === "running" && !input.allowWhileRunning) {
      if (input.queueWhileRunning === false) {
        throw new Error(
          `Thread '${thread.id}' is still running. Use interrupt first or pass a force path in code if you really want concurrent sends.`,
        );
      }

      const queued = await enqueueSend({
        threadId: thread.id,
        agentName: input.agentName ?? null,
        environment: this.environment.name,
        text,
        origin: input.origin ?? null,
        queuedDuringTurnId: thread.latestTurn?.turnId ?? null,
      });
      return {
        dispatched: false,
        queued: true,
        queuedSendId: queued.id,
        sequence: queued.sequence,
      };
    }

    const rpc = await this.openRpc();
    try {
      await rpc.request("dispatchCommand", {
        type: "thread.turn.start",
        commandId: NodeCrypto.randomUUID(),
        threadId: thread.id,
        message: {
          messageId: NodeCrypto.randomUUID(),
          role: "user",
          text,
          attachments: [],
          ...(input.origin ? { context: makeMessageOriginContext(input.origin) } : {}),
        },
        runtimeMode: thread.runtimeMode,
        interactionMode: thread.interactionMode,
        createdAt: nowIso(),
      });
    } finally {
      await rpc.dispose();
    }

    return { dispatched: true, queued: false };
  }

  async implementPlan(input: {
    threadId: string;
    planId?: string;
  }): Promise<{ threadId: string; planId: string; modeChanged: boolean }> {
    const rpc = await this.openRpc();
    try {
      const item = await rpc.subscribeThreadSnapshot<{
        kind: "snapshot";
        snapshot: {
          snapshotSequence: number;
          thread: OrchestrationThread;
        };
      }>(input.threadId);
      if (item.kind !== "snapshot") {
        throw new Error(
          `Expected a thread snapshot for '${input.threadId}', received '${item.kind}'.`,
        );
      }
      const thread = item.snapshot.thread;
      if (thread.archivedAt || thread.deletedAt) {
        throw new Error(`Thread '${thread.id}' is archived and cannot implement a plan.`);
      }
      if (threadHasActiveTurn(thread)) {
        throw new Error(`Thread '${thread.id}' is still running and cannot implement a plan.`);
      }

      const plan = selectPlanForImplementation(thread, input.planId);
      const createdAt = nowIso();
      let modeChanged = false;
      if (thread.interactionMode !== "default") {
        await rpc.request("dispatchCommand", {
          type: "thread.interaction-mode.set",
          commandId: NodeCrypto.randomUUID(),
          threadId: thread.id,
          interactionMode: "default",
          createdAt,
        });
        modeChanged = true;
      }

      try {
        await rpc.request("dispatchCommand", {
          type: "thread.turn.start",
          commandId: NodeCrypto.randomUUID(),
          threadId: thread.id,
          message: {
            messageId: NodeCrypto.randomUUID(),
            role: "user",
            text: buildPlanImplementationPrompt(plan.planMarkdown),
            attachments: [],
          },
          modelSelection: thread.modelSelection,
          titleSeed: thread.title,
          runtimeMode: thread.runtimeMode,
          interactionMode: "default",
          sourceProposedPlan: {
            threadId: thread.id,
            planId: plan.id,
          },
          createdAt,
        });
      } catch (error) {
        if (modeChanged) {
          const detail = error instanceof Error ? error.message : String(error);
          throw new Error(
            `Thread '${thread.id}' was switched to default mode, but the implementation turn failed to start: ${detail}`,
            { cause: error },
          );
        }
        throw error;
      }

      return { threadId: thread.id, planId: plan.id, modeChanged };
    } finally {
      await rpc.dispose();
    }
  }

  async applyThreadOrder(
    assignments: ReadonlyArray<{
      threadId: string;
      section: "pinned" | "active";
      orderKey: string;
    }>,
  ): Promise<void> {
    const capabilities = (await this.describe()).capabilities;
    for (const section of new Set(assignments.map((assignment) => assignment.section))) {
      const supported =
        section === "pinned"
          ? capabilities.threadPinReorder === true
          : capabilities.threadActiveReorder === true;
      if (!supported) {
        throw new Error(
          `'${this.environment.name}' runs a server without ${section} thread ordering. Update T3 Code there first.`,
        );
      }
    }
    const rpc = await this.openRpc();
    try {
      for (const assignment of assignments) {
        await rpc.request("dispatchCommand", {
          type: assignment.section === "pinned" ? "thread.pin.reorder" : "thread.active.reorder",
          commandId: NodeCrypto.randomUUID(),
          threadId: assignment.threadId,
          orderKey: assignment.orderKey,
        });
      }
    } finally {
      await rpc.dispose();
    }
  }

  async resetThreadOrder(threadId: string): Promise<void> {
    if ((await this.describe()).capabilities.threadOrderReset !== true) {
      throw new Error(
        `'${this.environment.name}' runs a server without automatic-order reset. Update T3 Code there first.`,
      );
    }
    await this.dispatchOnce({
      type: "thread.order.reset",
      commandId: NodeCrypto.randomUUID(),
      threadId,
    });
  }

  /** Whether this environment's server stores thread nesting (threadNesting capability). */
  /** Capabilities come from the environment descriptor; serverGetConfig does not carry them. */
  /** Named agents on this environment: singleton owners of one resource each. */
  async listNamedAgents(): Promise<NamedAgentSummary[]> {
    const rpc = await this.openRpc();
    try {
      return (await rpc.request<{ agents: NamedAgentSummary[] }>("listNamedAgents", {})).agents;
    } finally {
      await rpc.dispose();
    }
  }

  /** The agent's live thread; a dormant agent starts with `message` as its first request. */
  async resolveNamedAgent(
    name: string,
    message?: string,
  ): Promise<{ threadId: string; started: boolean }> {
    const rpc = await this.openRpc();
    try {
      return await rpc.request("resolveNamedAgent", {
        name,
        ...(message !== undefined ? { message } : {}),
      });
    } finally {
      await rpc.dispose();
    }
  }

  /** Replace the idle live incarnation with a fresh one seeded from the agent folder. */
  async handOverNamedAgent(
    name: string,
    message?: string,
  ): Promise<{ threadId: string; started: boolean }> {
    const rpc = await this.openRpc();
    try {
      return await rpc.request("handOverNamedAgent", {
        name,
        ...(message !== undefined ? { message } : {}),
      });
    } finally {
      await rpc.dispose();
    }
  }

  /** Make a project the home of a named agent, or (null) stop it being one. */
  async setPermanentAgent(projectId: string, name: string | null): Promise<void> {
    await this.dispatchOnce({
      type: "project.meta.update",
      commandId: NodeCrypto.randomUUID(),
      projectId,
      permanentAgent: name === null ? null : { name },
    });
  }

  async supportsThreadNesting(): Promise<boolean> {
    return (await this.describe()).capabilities.threadNesting === true;
  }

  /** Nests a thread under an orchestrating thread, or with null returns it to the sidebar. */
  async setThreadParent(threadId: string, parentThreadId: string | null): Promise<void> {
    if (!(await this.supportsThreadNesting())) {
      throw new Error(
        `'${this.environment.name}' runs a server without thread nesting. Update T3 Code there first.`,
      );
    }
    await this.dispatchOnce({
      type: "thread.parent.set",
      commandId: NodeCrypto.randomUUID(),
      threadId,
      parentThreadId,
    });
  }

  /** Answers a worker's pending question, the same as answering it in the app. */
  async respondToUserInput(input: {
    threadId: string;
    requestId: string;
    answers: Record<string, string>;
  }): Promise<void> {
    await this.dispatchOnce({
      type: "thread.user-input.respond",
      commandId: NodeCrypto.randomUUID(),
      threadId: input.threadId,
      requestId: input.requestId,
      answers: input.answers,
      createdAt: nowIso(),
    });
  }

  /** Approves or declines a worker's pending approval, the same as in the app. */
  async respondToApproval(input: {
    threadId: string;
    requestId: string;
    decision: "accept" | "acceptForSession" | "decline";
  }): Promise<void> {
    await this.dispatchOnce({
      type: "thread.approval.respond",
      commandId: NodeCrypto.randomUUID(),
      threadId: input.threadId,
      requestId: input.requestId,
      decision: input.decision,
      createdAt: nowIso(),
    });
  }

  private async dispatchOnce(command: Record<string, unknown>): Promise<void> {
    const rpc = await this.openRpc();
    try {
      await rpc.request("dispatchCommand", command);
    } finally {
      await rpc.dispose();
    }
  }

  async interrupt(threadId: string): Promise<void> {
    const thread = await this.findThread(threadId);
    const rpc = await this.openRpc();
    try {
      await rpc.request("dispatchCommand", {
        type: "thread.turn.interrupt",
        commandId: NodeCrypto.randomUUID(),
        threadId: thread.id,
        turnId: thread.latestTurn?.turnId,
        createdAt: nowIso(),
      });
    } finally {
      await rpc.dispose();
    }
  }

  async setThreadPinned(threadId: string, pinned: boolean) {
    const rpc = await this.openRpc();
    try {
      await rpc.request("dispatchCommand", {
        type: pinned ? "thread.pin" : "thread.unpin",
        commandId: NodeCrypto.randomUUID(),
        threadId,
      });
    } finally {
      await rpc.dispose();
    }
    const thread = await this.findThread(threadId);
    return {
      threadId: thread.id,
      environment: this.environment.name,
      pinned: thread.pinnedAt != null,
      pinnedAt: thread.pinnedAt ?? null,
    };
  }

  async linkIssue(
    threadId: string,
    reference: string,
  ): Promise<{
    link: ThreadIssueLink;
    changed: boolean;
  }> {
    const rpc = await this.openRpc();
    try {
      return await rpc.request("threadIssuesLink", { threadId, reference });
    } finally {
      await rpc.dispose();
    }
  }

  async unlinkIssue(
    threadId: string,
    reference: string,
  ): Promise<{
    unlinked: boolean;
    issue: { host: string; repository: string; number: number };
  }> {
    const rpc = await this.openRpc();
    try {
      return await rpc.request("threadIssuesUnlink", { threadId, reference });
    } finally {
      await rpc.dispose();
    }
  }

  async settleThread(threadId: string, options: { self?: boolean } = {}) {
    if (threadId === resolveCallerThreadId() && !options.self) {
      throw new Error(
        "Refusing to settle the calling thread. Use --self to request settlement after its current response finishes.",
      );
    }
    return this.setThreadSettlement(threadId, "thread.settle");
  }

  async unsettleThread(threadId: string) {
    return this.setThreadSettlement(threadId, "thread.unsettle");
  }

  private async setThreadSettlement(threadId: string, type: "thread.settle" | "thread.unsettle") {
    const rpc = await this.openRpc();
    try {
      await rpc.request("dispatchCommand", {
        type,
        commandId: NodeCrypto.randomUUID(),
        threadId,
        ...(type === "thread.unsettle" ? { reason: "user" } : {}),
      });
    } finally {
      await rpc.dispose();
    }
    // Dispatch completes after projection; read the server's resulting state.
    const thread = await this.findThread(threadId);
    return {
      threadId: thread.id,
      environment: this.environment.name,
      settledOverride: thread.settledOverride ?? null,
      settledAt: thread.settledAt ?? null,
      unsettledAt: thread.unsettledAt ?? null,
    };
  }

  async archiveThread(threadId: string): Promise<boolean> {
    const thread = await this.findThread(threadId);
    if (thread.archivedAt) {
      return false;
    }

    const rpc = await this.openRpc();
    try {
      await rpc.request("dispatchCommand", {
        type: "thread.archive",
        commandId: NodeCrypto.randomUUID(),
        threadId: thread.id,
      });
      return true;
    } finally {
      await rpc.dispose();
    }
  }

  async waitForThread(input: {
    threadId: string;
    goal: "completion" | "attention" | "idle" | "running";
    timeoutMs: number;
    intervalMs: number;
  }): Promise<OrchestrationThread> {
    const started = Date.now();
    for (;;) {
      const thread = await this.findThread(input.threadId);
      const status = classifyThread(thread);
      const matched =
        (input.goal === "completion" && status.state === "completed") ||
        (input.goal === "attention" &&
          ["needs-plan", "error", "completed", "interrupted"].includes(status.state)) ||
        (input.goal === "idle" && ["idle", "completed"].includes(status.state)) ||
        (input.goal === "running" && status.state === "running");

      if (matched) {
        return thread;
      }

      if (Date.now() - started > input.timeoutMs) {
        throw new Error(`Timed out waiting for thread '${input.threadId}' to reach ${input.goal}.`);
      }

      await new Promise((resolve) => setTimeout(resolve, input.intervalMs));
    }
  }

  private async openRpc(): Promise<RemoteRpcClient> {
    await this.refreshEnvironment();
    if (this.rpcFactory) {
      return this.rpcFactory(this.environment.wsBaseUrl);
    }
    const wsUrl = await resolveWebSocketUrl({
      httpBaseUrl: this.environment.httpBaseUrl,
      wsBaseUrl: this.environment.wsBaseUrl,
      bearerToken: this.environment.bearerToken,
    });
    return new T3RpcClient(wsUrl);
  }

  private async refreshEnvironment(): Promise<void> {
    if (this.rpcFactory) {
      return;
    }
    this.currentEnvironment = await refreshSavedEnvironmentSession(this.currentEnvironment);
  }
}
