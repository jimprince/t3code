import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { createEnvironmentConnection } from "./connection";
import type { WsRpcClient } from "@t3tools/client-runtime";

function createTestClient(options?: {
  readonly emitInitialSnapshot?: boolean;
  readonly emitSnapshotBeforeResubscribe?: boolean;
}) {
  const lifecycleListeners = new Set<(event: any) => void>();
  const configListeners = new Set<(event: any) => void>();
  const shellListeners = new Set<(event: any) => void>();
  let shellResubscribe: (() => void) | undefined;

  const client = {
    dispose: vi.fn(async () => undefined),
    isHeartbeatFresh: vi.fn(() => true),
    reconnect: vi.fn(async () => {
      if (options?.emitSnapshotBeforeResubscribe) {
        for (const listener of shellListeners) {
          listener({
            kind: "snapshot",
            snapshot: {
              snapshotSequence: 2,
              projects: [],
              threads: [],
              updatedAt: "2026-04-12T00:00:01.000Z",
            },
          });
        }
      }
      shellResubscribe?.();
    }),
    server: {
      getConfig: vi.fn(async () => ({
        environment: {
          environmentId: EnvironmentId.make("env-1"),
        },
      })),
      subscribeConfig: vi.fn((listener: (event: any) => void) => {
        configListeners.add(listener);
        return () => configListeners.delete(listener);
      }),
      subscribeLifecycle: vi.fn((listener: (event: any) => void) => {
        lifecycleListeners.add(listener);
        return () => lifecycleListeners.delete(listener);
      }),
      subscribeAuthAccess: () => () => undefined,
      refreshProviders: vi.fn(async () => undefined),
      upsertKeybinding: vi.fn(async () => undefined),
      getSettings: vi.fn(async () => undefined),
      updateSettings: vi.fn(async () => undefined),
    },
    orchestration: {
      dispatchCommand: vi.fn(async () => undefined),
      getTurnDiff: vi.fn(async () => undefined),
      getFullThreadDiff: vi.fn(async () => undefined),
      subscribeShell: vi.fn(
        (listener: (event: any) => void, subscribeOptions?: { onResubscribe?: () => void }) => {
          shellListeners.add(listener);
          shellResubscribe = subscribeOptions?.onResubscribe;
          if (options?.emitInitialSnapshot !== false) {
            queueMicrotask(() => {
              listener({
                kind: "snapshot",
                snapshot: {
                  snapshotSequence: 1,
                  projects: [],
                  threads: [],
                  updatedAt: "2026-04-12T00:00:00.000Z",
                },
              });
            });
          }
          return () => {
            shellListeners.delete(listener);
            if (shellResubscribe === subscribeOptions?.onResubscribe) {
              shellResubscribe = undefined;
            }
          };
        },
      ),
      subscribeThread: vi.fn(() => () => undefined),
    },
    terminal: {
      open: vi.fn(async () => undefined),
      attach: vi.fn(() => () => undefined),
      write: vi.fn(async () => undefined),
      resize: vi.fn(async () => undefined),
      clear: vi.fn(async () => undefined),
      restart: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
      onEvent: vi.fn(() => () => undefined),
      onMetadata: vi.fn(() => () => undefined),
    },
    projects: {
      searchEntries: vi.fn(async () => []),
      writeFile: vi.fn(async () => undefined),
    },
    shell: {
      openInEditor: vi.fn(async () => undefined),
    },
    git: {
      runStackedAction: vi.fn(async () => ({}) as any),
      resolvePullRequest: vi.fn(async () => undefined),
      preparePullRequestThread: vi.fn(async () => undefined),
    },
    review: {
      getDiffPreview: vi.fn(async () => undefined),
    },
  } as unknown as WsRpcClient;

  return {
    client,
    emitWelcome: (environmentId: EnvironmentId) => {
      for (const listener of lifecycleListeners) {
        listener({
          type: "welcome",
          payload: {
            environment: {
              environmentId,
            },
          },
        });
      }
    },
    emitConfigSnapshot: (environmentId: EnvironmentId) => {
      for (const listener of configListeners) {
        listener({
          type: "snapshot",
          config: {
            environment: {
              environmentId,
            },
          },
        });
      }
    },
    emitShellSnapshot: (snapshotSequence: number) => {
      for (const listener of shellListeners) {
        listener({
          kind: "snapshot",
          snapshot: {
            snapshotSequence,
            projects: [],
            threads: [],
            updatedAt: "2026-04-12T00:00:00.000Z",
          },
        });
      }
    },
  };
}

describe("createEnvironmentConnection", () => {
  it("bootstraps from the shell subscription snapshot", async () => {
    const environmentId = EnvironmentId.make("env-1");
    const { client } = createTestClient();
    const syncShellSnapshot = vi.fn();

    const connection = createEnvironmentConnection({
      kind: "saved",
      knownEnvironment: {
        id: "env-1",
        label: "Remote env",
        source: "manual",
        target: {
          httpBaseUrl: "http://example.test",
          wsBaseUrl: "ws://example.test",
        },
        environmentId,
      },
      client,
      applyShellEvent: vi.fn(),
      syncShellSnapshot,
    });

    await connection.ensureBootstrapped();

    expect(syncShellSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({ snapshotSequence: 1 }),
      environmentId,
    );

    await connection.dispose();
  });

  it("reports liveness when the config probe resolves", async () => {
    const environmentId = EnvironmentId.make("env-1");
    const { client } = createTestClient();

    const connection = createEnvironmentConnection({
      kind: "saved",
      knownEnvironment: {
        id: "env-1",
        label: "Remote env",
        source: "manual",
        target: {
          httpBaseUrl: "http://example.test",
          wsBaseUrl: "ws://example.test",
        },
        environmentId,
      },
      client,
      applyShellEvent: vi.fn(),
      syncShellSnapshot: vi.fn(),
    });

    await expect(connection.verifyLiveness()).resolves.toBe(true);
    expect(client.server.getConfig).toHaveBeenCalled();

    await connection.dispose();
  });

  it("reports not-alive when the config probe does not answer before the timeout", async () => {
    const environmentId = EnvironmentId.make("env-1");
    const { client } = createTestClient();
    (client.server.getConfig as ReturnType<typeof vi.fn>).mockImplementation(
      () => new Promise(() => undefined),
    );

    const connection = createEnvironmentConnection({
      kind: "saved",
      knownEnvironment: {
        id: "env-1",
        label: "Remote env",
        source: "manual",
        target: {
          httpBaseUrl: "http://example.test",
          wsBaseUrl: "ws://example.test",
        },
        environmentId,
      },
      client,
      applyShellEvent: vi.fn(),
      syncShellSnapshot: vi.fn(),
    });

    await expect(connection.verifyLiveness(10)).resolves.toBe(false);

    await connection.dispose();
  });

  it("rejects welcome/config identity drift", async () => {
    const environmentId = EnvironmentId.make("env-1");
    const { client, emitWelcome } = createTestClient();

    const connection = createEnvironmentConnection({
      kind: "saved",
      knownEnvironment: {
        id: "env-1",
        label: "Remote env",
        source: "manual",
        target: {
          httpBaseUrl: "http://example.test",
          wsBaseUrl: "ws://example.test",
        },
        environmentId,
      },
      client,
      applyShellEvent: vi.fn(),
      syncShellSnapshot: vi.fn(),
    });

    expect(() => emitWelcome(EnvironmentId.make("env-2"))).toThrow(
      "Environment connection env-1 changed identity to env-2 via server lifecycle welcome.",
    );

    await connection.dispose();
  });

  it("waits for a fresh shell snapshot after reconnect", async () => {
    const environmentId = EnvironmentId.make("env-1");
    const { client, emitShellSnapshot } = createTestClient();
    const syncShellSnapshot = vi.fn();

    const connection = createEnvironmentConnection({
      kind: "saved",
      knownEnvironment: {
        id: "env-1",
        label: "Remote env",
        source: "manual",
        target: {
          httpBaseUrl: "http://example.test",
          wsBaseUrl: "ws://example.test",
        },
        environmentId,
      },
      client,
      applyShellEvent: vi.fn(),
      syncShellSnapshot,
    });

    await connection.ensureBootstrapped();

    const reconnectPromise = connection.reconnect();
    await Promise.resolve();
    expect(syncShellSnapshot).toHaveBeenCalledTimes(1);

    emitShellSnapshot(2);
    await reconnectPromise;

    expect(client.reconnect).toHaveBeenCalledTimes(1);
    expect(syncShellSnapshot).toHaveBeenCalledTimes(2);
    expect(syncShellSnapshot).toHaveBeenLastCalledWith(
      expect.objectContaining({ snapshotSequence: 2 }),
      environmentId,
    );

    await connection.dispose();
  });

  it("does not hang when the reconnect snapshot arrives before the stream start hook settles", async () => {
    const environmentId = EnvironmentId.make("env-1");
    const { client } = createTestClient({ emitSnapshotBeforeResubscribe: true });
    const syncShellSnapshot = vi.fn();

    const connection = createEnvironmentConnection({
      kind: "saved",
      knownEnvironment: {
        id: "env-1",
        label: "Remote env",
        source: "manual",
        target: {
          httpBaseUrl: "http://example.test",
          wsBaseUrl: "ws://example.test",
        },
        environmentId,
      },
      client,
      applyShellEvent: vi.fn(),
      syncShellSnapshot,
      applyTerminalEvent: vi.fn(),
    });

    await connection.ensureBootstrapped();

    const result = await Promise.race([
      connection.reconnect().then(() => "resolved" as const),
      new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 20)),
    ]);

    expect(result).toBe("resolved");
    expect(syncShellSnapshot).toHaveBeenLastCalledWith(
      expect.objectContaining({ snapshotSequence: 2 }),
      environmentId,
    );

    await connection.dispose();
  });

  it("skips primary lifecycle/config subscriptions when no handlers are registered", async () => {
    const environmentId = EnvironmentId.make("env-1");
    const { client } = createTestClient();

    const connection = createEnvironmentConnection({
      kind: "primary",
      knownEnvironment: {
        id: "env-1",
        label: "Local env",
        source: "manual",
        target: {
          httpBaseUrl: "http://example.test",
          wsBaseUrl: "ws://example.test",
        },
        environmentId,
      },
      client,
      applyShellEvent: vi.fn(),
      syncShellSnapshot: vi.fn(),
      applyTerminalEvent: vi.fn(),
    });

    expect(client.server.subscribeLifecycle).not.toHaveBeenCalled();
    expect(client.server.subscribeConfig).not.toHaveBeenCalled();
    expect(client.orchestration.subscribeShell).toHaveBeenCalledOnce();

    await connection.dispose();
  });

  it("rejects bootstrap waits when a pending connection is disposed", async () => {
    const environmentId = EnvironmentId.make("env-1");
    const { client } = createTestClient({ emitInitialSnapshot: false });
    const connection = createEnvironmentConnection({
      kind: "saved",
      knownEnvironment: {
        id: "env-1",
        label: "Remote env",
        source: "manual",
        target: {
          httpBaseUrl: "http://example.test",
          wsBaseUrl: "ws://example.test",
        },
        environmentId,
      },
      client,
      applyShellEvent: vi.fn(),
      syncShellSnapshot: vi.fn(),
    });
    const pendingBootstrap = connection.ensureBootstrapped();

    await connection.dispose();

    await expect(pendingBootstrap).rejects.toThrow("was disposed before it finished bootstrapping");
  });
});
