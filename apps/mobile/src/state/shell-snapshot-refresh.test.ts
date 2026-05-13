import { afterEach, describe, expect, it, vi } from "vitest";

import type { WsRpcClient } from "@t3tools/client-runtime";
import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationShellSnapshot,
  type OrchestrationShellStreamItem,
  type OrchestrationThreadShell,
} from "@t3tools/contracts";

import { clearMobileDiagnostics } from "../lib/mobileDiagnostics";
import { refreshShellSnapshot } from "./shell-snapshot-refresh";
import { shellSnapshotManager } from "./use-shell-snapshot";

const ENVIRONMENT_ID = EnvironmentId.make("env-local");
const PROJECT_ID = ProjectId.make("project-1");
const TARGET_THREAD_ID = ThreadId.make("thread-1");

type ShellClient = Pick<WsRpcClient["orchestration"], "subscribeShell">;

function createThread(id: ThreadId): OrchestrationThreadShell {
  return {
    id,
    projectId: PROJECT_ID,
    title: "Thread",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    latestTurn: null,
    createdAt: "2026-05-13T00:00:00.000Z",
    updatedAt: "2026-05-13T00:00:00.000Z",
    archivedAt: null,
    session: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
  };
}

function createSnapshot(
  threads: ReadonlyArray<OrchestrationThreadShell>,
): OrchestrationShellSnapshot {
  return {
    snapshotSequence: threads.length,
    updatedAt: "2026-05-13T00:00:00.000Z",
    projects: [
      {
        id: PROJECT_ID,
        title: "Project",
        workspaceRoot: "/repo",
        repositoryIdentity: null,
        defaultModelSelection: null,
        scripts: [],
        createdAt: "2026-05-13T00:00:00.000Z",
        updatedAt: "2026-05-13T00:00:00.000Z",
      },
    ],
    threads: [...threads],
  };
}

function createClient(items: ReadonlyArray<OrchestrationShellStreamItem>): {
  readonly client: ShellClient;
  readonly unsubscribes: ReadonlyArray<ReturnType<typeof vi.fn>>;
} {
  const queue = [...items];
  const unsubscribes: Array<ReturnType<typeof vi.fn>> = [];
  const client: ShellClient = {
    subscribeShell: vi.fn((listener) => {
      const unsubscribe = vi.fn();
      unsubscribes.push(unsubscribe);
      const next = queue.shift();
      if (next) {
        listener(next);
      }
      return unsubscribe;
    }),
  };

  return { client, unsubscribes };
}

describe("refreshShellSnapshot", () => {
  afterEach(() => {
    shellSnapshotManager.invalidate({ environmentId: ENVIRONMENT_ID });
    clearMobileDiagnostics();
    vi.useRealTimers();
  });

  it("syncs the first shell snapshot and confirms the expected thread is visible", async () => {
    const snapshot = createSnapshot([createThread(TARGET_THREAD_ID)]);
    const { client, unsubscribes } = createClient([{ kind: "snapshot", snapshot }]);

    const result = await refreshShellSnapshot({
      client,
      environmentId: ENVIRONMENT_ID,
      expectedThreadId: TARGET_THREAD_ID,
      retryDelayMs: 0,
      timeoutMs: 100,
    });

    expect(result).toEqual({
      snapshot,
      hasExpectedThread: true,
      attempts: 1,
    });
    expect(shellSnapshotManager.getSnapshot({ environmentId: ENVIRONMENT_ID }).data).toEqual(
      snapshot,
    );
    expect(unsubscribes[0]).toHaveBeenCalledOnce();
  });

  it("retries when the immediate snapshot does not include the created thread", async () => {
    const staleSnapshot = createSnapshot([]);
    const freshSnapshot = createSnapshot([createThread(TARGET_THREAD_ID)]);
    const { client } = createClient([
      { kind: "snapshot", snapshot: staleSnapshot },
      { kind: "snapshot", snapshot: freshSnapshot },
    ]);

    const result = await refreshShellSnapshot({
      client,
      environmentId: ENVIRONMENT_ID,
      expectedThreadId: TARGET_THREAD_ID,
      retryDelayMs: 0,
      timeoutMs: 100,
    });

    expect(client.subscribeShell).toHaveBeenCalledTimes(2);
    expect(result.hasExpectedThread).toBe(true);
    expect(result.attempts).toBe(2);
    expect(shellSnapshotManager.getSnapshot({ environmentId: ENVIRONMENT_ID }).data).toEqual(
      freshSnapshot,
    );
  });

  it("returns the latest snapshot without confirming visibility after the final attempt", async () => {
    const snapshot = createSnapshot([]);
    const { client } = createClient([
      { kind: "snapshot", snapshot },
      { kind: "snapshot", snapshot },
    ]);

    const result = await refreshShellSnapshot({
      client,
      environmentId: ENVIRONMENT_ID,
      expectedThreadId: TARGET_THREAD_ID,
      maxAttempts: 2,
      retryDelayMs: 0,
      timeoutMs: 100,
    });

    expect(client.subscribeShell).toHaveBeenCalledTimes(2);
    expect(result).toEqual({
      snapshot,
      hasExpectedThread: false,
      attempts: 2,
    });
  });
});
