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
import { classifyThread } from "./status.js";
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
import type { ServerConfig, ServerProvider } from "./vendor/t3contracts/server.js";

const DEFAULT_MODEL_SELECTION: ModelSelection = {
  provider: "codex",
  model: "gpt-5.4",
};

type RemoteRpcClient = Pick<
  T3RpcClient,
  "request" | "subscribeShellSnapshot" | "subscribeThreadSnapshot" | "dispose"
>;

type RpcFactory = (wsUrl: string) => RemoteRpcClient;

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
  readonly environment: SavedEnvironment;
  private readonly rpcFactory: RpcFactory | null;

  constructor(environment: SavedEnvironment, options: { rpcFactory?: RpcFactory } = {}) {
    this.environment = environment;
    this.rpcFactory = options.rpcFactory ?? null;
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
  }): Promise<{ threadId: string; projectId: string; title: string }> {
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
      await rpc.request("dispatchCommand", {
        type: "thread.turn.start",
        commandId: NodeCrypto.randomUUID(),
        threadId,
        message: {
          messageId: NodeCrypto.randomUUID(),
          role: "user",
          text: initialMessage,
          attachments: [],
        },
        modelSelection,
        titleSeed: input.title,
        runtimeMode,
        interactionMode,
        bootstrap: {
          createThread: {
            projectId: project.id,
            title: input.title,
            modelSelection,
            runtimeMode,
            interactionMode,
            branch: null,
            worktreePath: null,
            createdAt,
          },
          ...(input.branch
            ? {
                prepareWorktree: {
                  projectCwd: project.workspaceRoot,
                  baseBranch: input.baseBranch ?? "main",
                  branch: input.branch,
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

    return {
      threadId,
      projectId: project.id,
      title: input.title,
    };
  }

  async sendMessage(input: {
    threadId: string;
    text: string;
    allowWhileRunning?: boolean;
  }): Promise<void> {
    const thread = await this.findThread(input.threadId);
    const status = classifyThread(thread);
    if (status.state === "running" && !input.allowWhileRunning) {
      throw new Error(
        `Thread '${thread.id}' is still running. Use interrupt first or pass a force path in code if you really want concurrent sends.`,
      );
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
          text: input.text,
          attachments: [],
        },
        runtimeMode: thread.runtimeMode,
        interactionMode: thread.interactionMode,
        createdAt: nowIso(),
      });
    } finally {
      await rpc.dispose();
    }
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
    const wsUrl = await resolveWebSocketUrl({
      httpBaseUrl: this.environment.httpBaseUrl,
      wsBaseUrl: this.environment.wsBaseUrl,
      bearerToken: this.environment.bearerToken,
    });
    return new T3RpcClient(wsUrl);
  }
}
