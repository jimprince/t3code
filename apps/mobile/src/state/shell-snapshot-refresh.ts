import type { WsRpcClient } from "@t3tools/client-runtime";
import type { EnvironmentId, OrchestrationShellSnapshot, ThreadId } from "@t3tools/contracts";

import { recordMobileDiagnostic } from "../lib/mobileDiagnostics";
import { shellSnapshotManager } from "./use-shell-snapshot";

export interface ShellSnapshotRefreshResult {
  readonly snapshot: OrchestrationShellSnapshot;
  readonly hasExpectedThread: boolean;
  readonly attempts: number;
}

export interface RefreshShellSnapshotOptions {
  readonly client: Pick<WsRpcClient["orchestration"], "subscribeShell">;
  readonly environmentId: EnvironmentId;
  readonly expectedThreadId?: ThreadId;
  readonly maxAttempts?: number;
  readonly retryDelayMs?: number;
  readonly timeoutMs?: number;
}

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_RETRY_DELAY_MS = 250;
const DEFAULT_TIMEOUT_MS = 8_000;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function snapshotHasThread(snapshot: OrchestrationShellSnapshot, threadId: ThreadId): boolean {
  return snapshot.threads.some((thread) => thread.id === threadId);
}

function readShellSnapshotOnce(
  client: Pick<WsRpcClient["orchestration"], "subscribeShell">,
  timeoutMs: number,
): Promise<OrchestrationShellSnapshot> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let unsubscribe: (() => void) | null = null;
    let shouldUnsubscribe = false;

    const timeout = setTimeout(() => {
      settle(() => reject(new Error("Timed out waiting for shell snapshot.")));
    }, timeoutMs);

    const cleanup = () => {
      clearTimeout(timeout);
      if (unsubscribe) {
        unsubscribe();
        return;
      }
      shouldUnsubscribe = true;
    };

    const settle = (complete: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      complete();
    };

    unsubscribe = client.subscribeShell(
      (item) => {
        if (item.kind !== "snapshot") {
          return;
        }
        settle(() => resolve(item.snapshot));
      },
      {
        onError: (message) => {
          settle(() => reject(new Error(message)));
        },
      },
    );

    if (shouldUnsubscribe) {
      unsubscribe();
    }
  });
}

export async function refreshShellSnapshot(
  options: RefreshShellSnapshotOptions,
): Promise<ShellSnapshotRefreshResult> {
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    recordMobileDiagnostic({
      level: "debug",
      tag: "mobile.shell.refresh.start",
      data: {
        environmentId: options.environmentId,
        attempt,
        maxAttempts,
        expectedThreadId: options.expectedThreadId ?? null,
      },
    });

    const snapshot = await readShellSnapshotOnce(options.client, timeoutMs);
    shellSnapshotManager.syncSnapshot({ environmentId: options.environmentId }, snapshot);

    const hasExpectedThread = options.expectedThreadId
      ? snapshotHasThread(snapshot, options.expectedThreadId)
      : true;

    recordMobileDiagnostic({
      level: hasExpectedThread ? "info" : "warn",
      tag: "mobile.shell.refresh.snapshot",
      data: {
        environmentId: options.environmentId,
        attempt,
        projectCount: snapshot.projects.length,
        threadCount: snapshot.threads.length,
        expectedThreadId: options.expectedThreadId ?? null,
        hasExpectedThread,
      },
    });

    if (hasExpectedThread || attempt === maxAttempts) {
      return {
        snapshot,
        hasExpectedThread,
        attempts: attempt,
      };
    }

    await delay(retryDelayMs);
  }

  throw new Error("Shell snapshot refresh failed before any snapshot was received.");
}
