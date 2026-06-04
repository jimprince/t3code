import { randomUUID } from "node:crypto";

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
  OrchestrationProjectShell,
  OrchestrationShellSnapshot,
  OrchestrationThread,
  OrchestrationThreadShell,
  SavedEnvironment,
} from "./types.js";

const DEFAULT_MODEL_SELECTION: ModelSelection = {
  provider: "codex",
  model: "gpt-5.4",
};

function nowIso(): string {
  return new Date().toISOString();
}

export class RemoteEnvironmentClient {
  readonly environment: SavedEnvironment;

  constructor(environment: SavedEnvironment) {
    this.environment = environment;
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

    const projectId = randomUUID();
    const title = deriveProjectTitle(input.workspaceRoot, input.title);
    const defaultModelSelection = buildModelSelection({
      provider: input.provider,
      model: input.model,
      optionEntries: input.modelOptionEntries,
      noDefault: input.noDefaultModel,
    });
    const command = buildProjectCreateCommand({
      commandId: randomUUID(),
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

  async renameProject(input: { identifier: string; title: string }): Promise<OrchestrationProjectShell> {
    const snapshot = await this.getShellSnapshot();
    const project = resolveProjectTarget(snapshot.projects, input.identifier);
    const command = buildProjectMetaUpdateCommand({
      commandId: randomUUID(),
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
    const defaultModelSelection = buildModelSelection({
      provider: input.provider,
      model: input.model,
      optionEntries: input.modelOptionEntries,
      clear: input.clear,
    });
    const command = buildProjectMetaUpdateCommand({
      commandId: randomUUID(),
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
      commandId: randomUUID(),
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

    const modelSelection =
      input.model || input.provider
        ? (buildModelSelection({
            provider: input.provider,
            model: input.model,
          }) ?? DEFAULT_MODEL_SELECTION)
        : (project.defaultModelSelection ?? DEFAULT_MODEL_SELECTION);

    const threadId = randomUUID();
    const runtimeMode = input.runtimeMode ?? "full-access";
    const interactionMode = input.interactionMode ?? "default";
    const createdAt = nowIso();
    const rpc = await this.openRpc();
    try {
      await rpc.request("dispatchCommand", {
        type: "thread.turn.start",
        commandId: randomUUID(),
        threadId,
        message: {
          messageId: randomUUID(),
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
        commandId: randomUUID(),
        threadId: thread.id,
        message: {
          messageId: randomUUID(),
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

  async interrupt(threadId: string): Promise<void> {
    const thread = await this.findThread(threadId);
    const rpc = await this.openRpc();
    try {
      await rpc.request("dispatchCommand", {
        type: "thread.turn.interrupt",
        commandId: randomUUID(),
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
        commandId: randomUUID(),
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

  private async openRpc(): Promise<T3RpcClient> {
    const wsUrl = await resolveWebSocketUrl({
      httpBaseUrl: this.environment.httpBaseUrl,
      wsBaseUrl: this.environment.wsBaseUrl,
      bearerToken: this.environment.bearerToken,
    });
    return new T3RpcClient(wsUrl);
  }
}
