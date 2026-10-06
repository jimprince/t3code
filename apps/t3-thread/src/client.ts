import { openRpcConnection } from "./openRpc.js";
import type { NamedAgentSummary } from "./namedAgents.js";
import { withThreadMetadata, type ThreadMetadata } from "./v2/nesting.js";
import { projectionHasWork } from "./v2/workState.js";
import { threadShell as gcThreadShell } from "./v2/reads.js";
import type { WorktreeGcThread } from "./worktreeGc.js";
import type { OrchestrationV2ShellSnapshot } from "@t3tools/contracts";
import { makeMessageOriginContext } from "@t3tools/shared/messageOrigin";
import { planExplicitThreadOrder, sameThreadOrderGroup } from "./threadOrder.js";
import type { QueuedSendOrigin } from "./types.js";
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
  | {
      dispatched: false;
      queued: true;
      queuedSendId: string;
      sequence: number;
      supersededSendIds?: string[];
    };

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

export type AutomationRpcMethod =
  | "automationsList"
  | "automationsSave"
  | "automationsRemove"
  | "automationsSetEnabled"
  | "automationsRun"
  | "automationsRuns"
  | "automationScriptsList"
  | "automationScriptsSave"
  | "automationScriptsRemove"
  | "automationScriptsRun";

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
    const rpc = await this.openRpc();
    try {
      await rpc.request("projectsMutate", {
        type: "project.update",
        commandId: NodeCrypto.randomUUID(),
        projectId,
        permanentAgent: name === null ? null : { name },
      });
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

  /** Scripts and automation rules; see apps/server/src/automations. */
  async automationRpc<T = unknown>(
    method: AutomationRpcMethod,
    input: Record<string, unknown>,
  ): Promise<T> {
    const rpc = await this.openRpc();
    try {
      return await rpc.request<T>(method, input);
    } finally {
      await rpc.dispose();
    }
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

  async renameThread(input: {
    threadId: string;
    title?: string;
    scope?: string | null;
  }): Promise<{ threadId: string; title: string; scope: string | null }> {
    const title = input.title?.trim();
    const scope = input.scope === undefined ? undefined : input.scope?.trim() || null;
    if (input.title !== undefined && !title) throw new Error("Thread title must not be empty.");
    if (title === undefined && scope === undefined)
      throw new Error("Thread title or scope must be provided.");
    const rpc = await this.openRpc();
    try {
      if (title !== undefined)
        await rpc.request("dispatchCommand", {
          type: "thread.metadata.update",
          commandId: NodeCrypto.randomUUID(),
          threadId: input.threadId,
          title,
        });
      if (scope !== undefined)
        await rpc.request("threadMetadataUpdate", {
          commandId: NodeCrypto.randomUUID(),
          threadId: input.threadId,
          scope,
        });
    } finally {
      await rpc.dispose();
    }
    const thread = await this.findThread(input.threadId);
    if (title !== undefined && thread.title !== title)
      throw new Error("Thread title readback did not match.");
    if (scope !== undefined && (thread.scope ?? null) !== scope)
      throw new Error("Thread scope readback did not match.");
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
    initialMessage?: string;
    workerContext?: WorkerContext;
    parentThreadId?: string | null;
    settleOnComplete?: boolean;
    pin?: boolean;
    remoteParent?: { environmentId: string; threadId: string };
  }): Promise<{ threadId: string; projectId: string; title: string; pinned: boolean }> {
    const title = input.title.trim();
    if (!title) throw new Error("Thread title must not be empty.");
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
    const launch = {
      commandId: NodeCrypto.randomUUID(),
      threadId,
      projectId: project.id,
      title,
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
    };
    try {
      // Claim an empty thread before applying worker metadata and starting its first turn.
      await rpc.request("launchThread", {
        commandId: NodeCrypto.randomUUID(),
        threadId,
        projectId: project.id,
        title,
        generateTitle: false,
        modelSelection: wireModel(modelSelection),
        runtimeMode,
        interactionMode,
        workspaceStrategy: input.branch
          ? { type: "worktree", branch: input.branch, baseRef: input.baseBranch ?? "main" }
          : { type: "root" },
      });
      // One metadata write between the empty claim and the first turn: organizational
      // parent (local or remote) and completion policy land before the worker starts.
      await rpc.request("threadMetadataUpdate", {
        commandId: NodeCrypto.randomUUID(),
        threadId,
        settleOnComplete,
        ...(input.parentThreadId || input.remoteParent
          ? {
              parentThreadId: input.parentThreadId ?? null,
              remoteParent: input.remoteParent ?? null,
            }
          : {}),
      });
      await rpc.request("launchThread", { ...launch, reuseExistingThread: true });
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
    commandId?: string;
    threadId: string;
    text: string;
    allowWhileRunning?: boolean;
    queueWhileRunning?: boolean;
    agentName?: string | null;
    /** Identifies the sender for local queue coalescing and summaries. */
    origin?: QueuedSendOrigin | null;
    /** Replace this sender's still-waiting queued send that carries the same key. */
    coalesceKey?: string | null;
    senderEnvironment?: string;
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

      const { queued, superseded } = await enqueueSend({
        threadId: thread.id,
        agentName: input.agentName ?? null,
        environment: this.environment.name,
        text: input.text,
        origin: input.origin
          ? {
              ...input.origin,
              ...(input.senderEnvironment ? { senderEnvironment: input.senderEnvironment } : {}),
            }
          : null,
        coalesceKey: input.coalesceKey ?? null,
        queuedDuringTurnId: thread.latestTurn?.turnId ?? null,
      });
      return {
        dispatched: false,
        queued: true,
        queuedSendId: queued.id,
        sequence: queued.sequence,
        ...(superseded.length > 0 ? { supersededSendIds: superseded.map(({ id }) => id) } : {}),
      };
    }

    const rpc = await this.openRpc();
    try {
      await rpc.request("dispatchCommand", {
        type: "message.dispatch",
        createdBy: "user",
        creationSource: "server",
        commandId: input.commandId ?? NodeCrypto.randomUUID(),
        threadId: thread.id,
        messageId: input.commandId ? `${input.commandId}:message` : NodeCrypto.randomUUID(),
        text: input.text,
        attachments: [],
        ...(input.origin
          ? {
              context: makeMessageOriginContext(input.origin),
              senderThreadId: input.origin.fromThreadId,
            }
          : {}),
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
        createdBy: "user",
        creationSource: "server",
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
    const previouslyPinned = pinned && (await this.findThread(threadId)).pinnedAt != null;
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
    if (pinned && !previouslyPinned) {
      const siblings = (await this.listThreads()).filter((candidate) =>
        sameThreadOrderGroup(thread, candidate),
      );
      if (siblings.some((candidate) => candidate.id !== thread.id)) {
        const assignments = planExplicitThreadOrder({ group: siblings, leadingIds: [thread.id] });
        const orderRpc = await this.openRpc();
        try {
          for (const assignment of assignments)
            await orderRpc.request("dispatchCommand", {
              type: "thread.pin.reorder",
              commandId: NodeCrypto.randomUUID(),
              threadId: assignment.threadId,
              orderKey: assignment.orderKey,
            });
        } finally {
          await orderRpc.dispose();
        }
      }
    }
    return {
      threadId: thread.id,
      environment: this.environment.name,
      pinned: thread.pinnedAt != null,
      pinnedAt: thread.pinnedAt ?? null,
    };
  }

  async setThreadAutoSettle(threadId: string, enabled: boolean) {
    const rpc = await this.openRpc();
    try {
      await rpc.request("dispatchCommand", {
        type: "thread.auto-settle.set",
        commandId: NodeCrypto.randomUUID(),
        threadId,
        enabled,
      });
    } finally {
      await rpc.dispose();
    }
    const thread = await this.findThread(threadId);
    return {
      threadId: thread.id,
      environment: this.environment.name,
      autoSettle: (thread.autoSettleDisabledAt ?? null) === null,
      autoSettleDisabledAt: thread.autoSettleDisabledAt ?? null,
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

  /** Request ledger: requests are Gitea issues labeled `ask` in the project's tracker. */
  async projectRequest<T>(
    method: "projectRequestsCreate" | "projectRequestsUpdate" | "projectRequestsList",
    input: Record<string, unknown>,
  ): Promise<T> {
    const rpc = await this.openRpc();
    try {
      return await rpc.request<T>(method, input);
    } finally {
      await rpc.dispose();
    }
  }

  /** Project page widgets and the project's Gitea tracker repository. */
  async projectDashboard<T>(
    method:
      | "projectDashboardGet"
      | "projectDashboardSetWidgets"
      | "projectDashboardSetTracker"
      | "projectDashboardSetHealth",
    input: Record<string, unknown>,
  ): Promise<T> {
    const rpc = await this.openRpc();
    try {
      return await rpc.request<T>(method, input);
    } finally {
      await rpc.dispose();
    }
  }

  /** The project page's layout: tabs of widgets, changed through ops. */
  async projectLayout<T>(
    method: "projectLayoutGet" | "projectLayoutApply",
    input: Record<string, unknown>,
  ): Promise<T> {
    const rpc = await this.openRpc();
    try {
      return await rpc.request<T>(method, input);
    } finally {
      await rpc.dispose();
    }
  }

  /** Project roadmap: versions as Gitea milestones on the project's tracker. */
  async projectRoadmap<T>(
    method: "projectRoadmapGet" | "projectRoadmapMove" | "projectRoadmapSaveVersion",
    input: Record<string, unknown>,
  ): Promise<T> {
    const rpc = await this.openRpc();
    try {
      return await rpc.request<T>(method, input);
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
    if (this.rpcFactory) {
      return this.rpcFactory(this.environment.wsBaseUrl);
    }
    return openRpcConnection(this.environment, {
      prepare: async (signal) => {
        this.currentEnvironment = await refreshSavedEnvironmentSession(this.currentEnvironment, {
          signal,
        });
        return this.environment;
      },
    });
  }
  private async refreshEnvironment(): Promise<void> {
    if (this.rpcFactory) return;
    this.currentEnvironment = await refreshSavedEnvironmentSession(this.currentEnvironment);
  }
}
