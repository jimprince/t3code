import { withThreadMetadata, type ThreadMetadata } from "./v2/nesting.js";
import { projectionHasWork } from "./v2/workState.js";
import { threadShell as gcThreadShell } from "./v2/reads.js";
import type { WorktreeGcThread } from "./worktreeGc.js";
import type { OrchestrationV2ShellSnapshot } from "@t3tools/contracts";
import { refreshSavedEnvironmentSession } from "./sessionRefresh.js";
import { pendingRequests, requirePendingRequest } from "./v2/requests.js";
import { wrapWithPreamble, type WorkerContext } from "./thread-preamble.js";
import type { ProjectAutomation } from "./types.js";
import { wireModel } from "./v2/commands.js";
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
import type {
  ExecutionEnvironmentDescriptor,
  ModelSelection,
  OrchestrationProposedPlan,
  OrchestrationProjectShell,
  OrchestrationShellSnapshot,
  OrchestrationThread,
  OrchestrationThreadShell,
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
  private readonly descriptorFactory: (() => Promise<ExecutionEnvironmentDescriptor>) | null;

  constructor(
    environment: SavedEnvironment,
    options: {
      rpcFactory?: RpcFactory;
      descriptorFactory?: () => Promise<ExecutionEnvironmentDescriptor>;
    } = {},
  ) {
    this.currentEnvironment = environment;
    this.rpcFactory = options.rpcFactory ?? null;
    this.descriptorFactory = options.descriptorFactory ?? null;
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
    if (this.descriptorFactory) return this.descriptorFactory();
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
        threads: await this.applyThreadMetadata(item.snapshot.threads, rpc),
      };
    } finally {
      await rpc.dispose();
    }
  }

  async supportsThreadNesting(): Promise<boolean> {
    return (await this.describe()).capabilities.threadNesting === true;
  }

  private async applyThreadMetadata<T extends { id: string; parentThreadId?: string | null }>(
    threads: T[],
    rpc: RemoteRpcClient,
  ): Promise<T[]> {
    if (!(await this.supportsThreadNesting())) return threads;
    const rows = await rpc.request<ThreadMetadata[]>("threadMetadataList", {});
    return threads.map((thread) => withThreadMetadata(thread, rows));
  }

  async setThreadParent(
    threadId: string,
    parentThreadId: string | null,
    remoteParent: { environmentId: string; threadId: string } | null = null,
  ): Promise<ThreadMetadata> {
    const descriptor = await this.describe();
    if (
      descriptor.capabilities.threadNesting !== true ||
      (remoteParent !== null && descriptor.capabilities.remoteThreadNesting !== true)
    ) {
      throw new Error(
        `'${this.environment.name}' runs a server without the required thread nesting capability.`,
      );
    }
    const rpc = await this.openRpc();
    try {
      return await rpc.request<ThreadMetadata>("threadMetadataUpdate", {
        commandId: NodeCrypto.randomUUID(),
        threadId,
        parentThreadId,
        remoteParent,
      });
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

  async dispatchAutomation(_command: {
    type: string;
    projectId: string;
    commandId: string;
    automation?: unknown;
    automationId?: string;
  }): Promise<readonly ProjectAutomation[]> {
    throw new Error("Project automation commands require the M3 automation services.");
  }

  async listWorktreeGcThreads(): Promise<WorktreeGcThread[]> {
    const rpc = await this.openRpc();
    try {
      const archived = await rpc.request<OrchestrationV2ShellSnapshot>(
        "getArchivedShellSnapshot",
        {},
      );
      const rows: WorktreeGcThread[] = [];
      for (const raw of archived.threads) {
        const thread = gcThreadShell(raw);
        if (!thread.worktreePath) continue;
        // Native thread snapshots retain active execution entities. Read them
        // before planning, and again through this method before each removal.
        const detail = await rpc.subscribeThreadSnapshot<{
          kind: "snapshot";
          snapshot: { thread: OrchestrationThread };
        }>(thread.id);
        if (!detail.snapshot.thread.projection)
          throw new Error("GC requires a V2 execution projection.");
        rows.push({
          id: thread.id,
          worktreePath: thread.worktreePath,
          archivedAt: thread.archivedAt,
          workActive: projectionHasWork(detail.snapshot.thread.projection),
        });
      }
      // A just-unarchived thread vetoes every alias of its checkout.
      const active = await this.listThreads();
      return [
        ...rows,
        ...active.map((thread) => ({
          id: thread.id,
          worktreePath: thread.worktreePath,
          archivedAt: null,
          workActive: true,
        })),
      ];
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
      await rpc.request("projectsMutate", {
        ...command,
        ...("defaultModelSelection" in command && command.defaultModelSelection
          ? { defaultModelSelection: wireModel(command.defaultModelSelection as ModelSelection) }
          : {}),
      });
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
      await rpc.request("projectsMutate", {
        ...command,
        type: "project.update",
        ...("defaultModelSelection" in command && command.defaultModelSelection
          ? { defaultModelSelection: wireModel(command.defaultModelSelection as ModelSelection) }
          : {}),
      });
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
      await rpc.request("projectsMutate", {
        ...command,
        type: "project.update",
        ...("defaultModelSelection" in command && command.defaultModelSelection
          ? { defaultModelSelection: wireModel(command.defaultModelSelection as ModelSelection) }
          : {}),
      });
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
      await rpc.request("projectsMutate", {
        ...command,
        ...("defaultModelSelection" in command && command.defaultModelSelection
          ? { defaultModelSelection: wireModel(command.defaultModelSelection as ModelSelection) }
          : {}),
      });
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
      return (await this.applyThreadMetadata([item.snapshot.thread], rpc))[0]!;
    } finally {
      await rpc.dispose();
    }
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
    initialMessage?: string;
    workerContext?: WorkerContext;
    pin?: boolean;
    parentThreadId?: string;
    remoteParent?: { environmentId: string; threadId: string };
  }): Promise<{ threadId: string; projectId: string; title: string; pinned: boolean }> {
    if ((input.parentThreadId || input.remoteParent) && !(await this.supportsThreadNesting())) {
      throw new Error(
        `'${this.environment.name}' runs a server without thread nesting. No worker was created.`,
      );
    }
    if (input.remoteParent && (await this.describe()).capabilities.remoteThreadNesting !== true) {
      throw new Error(
        `'${this.environment.name}' runs a server without cross-environment nesting. No worker was created.`,
      );
    }
    const snapshot = await this.getShellSnapshot();
    const project = snapshot.projects.find((candidate) => candidate.id === input.projectId);
    if (!project) {
      throw new Error(`Project '${input.projectId}' was not found in '${this.environment.name}'.`);
    }
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

    const threadId = NodeCrypto.randomUUID();
    const runtimeMode = input.runtimeMode ?? "full-access";
    const interactionMode = input.interactionMode ?? "default";
    const createdAt = nowIso();
    const rpc = await this.openRpc();
    try {
      await rpc.request("launchThread", {
        commandId: NodeCrypto.randomUUID(),
        threadId,
        projectId: project.id,
        title: input.title,
        generateTitle: false,
        modelSelection: wireModel(modelSelection),
        runtimeMode,
        interactionMode,
        workspaceStrategy: input.branch
          ? { type: "worktree", branch: input.branch, baseRef: input.baseBranch ?? "main" }
          : { type: "root" },
        initialMessage: {
          messageId: NodeCrypto.randomUUID(),
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
      });
    } finally {
      await rpc.dispose();
    }

    if (input.parentThreadId || input.remoteParent) {
      try {
        await this.setThreadParent(
          threadId,
          input.parentThreadId ?? null,
          input.remoteParent ?? null,
        );
      } catch (error) {
        throw new Error(
          `Worker '${threadId}' was created but nesting failed. Attach that thread instead of retrying creation.`,
          { cause: error },
        );
      }
    }
    const pinState = input.pin ? await this.setThreadPinned(threadId, true) : null;
    return {
      threadId,
      projectId: project.id,
      title: input.title,
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
  }): Promise<SendMessageOutcome> {
    const thread = await this.findThread(input.threadId);
    if (thread.archivedAt || thread.deletedAt) {
      throw new Error(`Thread '${thread.id}' is archived and cannot receive messages.`);
    }

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
        text: input.text,
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
        type: "message.dispatch",
        commandId: NodeCrypto.randomUUID(),
        threadId: thread.id,
        messageId: NodeCrypto.randomUUID(),
        text: input.text,
        attachments: [],
        dispatchMode:
          input.allowWhileRunning && thread.latestTurn?.state === "running"
            ? { type: "steer_active", targetRunId: thread.latestTurn.turnId }
            : { type: "start_immediately" },
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
      const modeChanged = thread.interactionMode !== "default";
      if (modeChanged)
        await rpc.request("dispatchCommand", {
          type: "thread.interaction-mode.set",
          commandId: NodeCrypto.randomUUID(),
          threadId: thread.id,
          interactionMode: "default",
        });
      await rpc.request("dispatchCommand", {
        type: "message.dispatch",
        commandId: NodeCrypto.randomUUID(),
        threadId: thread.id,
        messageId: NodeCrypto.randomUUID(),
        text: buildPlanImplementationPrompt(plan.planMarkdown),
        attachments: [],
        sourcePlanRef: { threadId: thread.id, planId: plan.id },
        dispatchMode: { type: "start_immediately" },
      });

      return { threadId: thread.id, planId: plan.id, modeChanged };
    } finally {
      await rpc.dispose();
    }
  }

  async pending(threadId: string) {
    return pendingRequests(await this.findThread(threadId));
  }

  async respond(input: {
    threadId: string;
    requestId: string;
    decision?: "accept" | "decline" | "cancel";
    answers?: Record<string, unknown>;
  }) {
    const thread = await this.findThread(input.threadId);
    const request = requirePendingRequest(thread, input.requestId);
    if (request.kind === "user_input" ? input.answers === undefined : input.decision === undefined)
      throw new Error("Response must match the request kind.");
    const rpc = await this.openRpc();
    try {
      return await rpc.request("dispatchCommand", {
        type: "runtime-request.respond",
        commandId: NodeCrypto.randomUUID(),
        ...input,
      });
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
    const rpc = await this.openRpc();
    try {
      await rpc.request("threadOrderReset", {
        commandId: NodeCrypto.randomUUID(),
        threadId,
      });
    } finally {
      await rpc.dispose();
    }
  }

  async interrupt(threadId: string): Promise<void> {
    const thread = await this.findThread(threadId);
    const rpc = await this.openRpc();
    try {
      await rpc.request("dispatchCommand", {
        type: "run.interrupt",
        commandId: NodeCrypto.randomUUID(),
        threadId: thread.id,
        runId: thread.latestTurn?.turnId,
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
    if (this.rpcFactory) return;
    this.currentEnvironment = await refreshSavedEnvironmentSession(this.currentEnvironment);
  }
}
