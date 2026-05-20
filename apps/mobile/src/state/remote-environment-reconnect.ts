import type { EnvironmentRuntimeState } from "@t3tools/client-runtime";

export const SHELL_SNAPSHOT_RESUME_TIMEOUT_MS = 8_000;
export const SHELL_SNAPSHOT_RESUME_TIMEOUT_MESSAGE =
  "Shell snapshot did not resume after WebSocket reconnect.";

type TimerHandle = ReturnType<typeof setTimeout>;

export function deriveRuntimeStateForConnectionAttempt(
  previous: EnvironmentRuntimeState,
): EnvironmentRuntimeState {
  const connectionState =
    previous.connectionState === "idle" || previous.connectionState === "connecting"
      ? "connecting"
      : "reconnecting";

  return {
    ...previous,
    connectionState,
    connectionError: null,
  };
}

export function deriveRuntimeStateForSocketOpen(
  previous: EnvironmentRuntimeState,
): EnvironmentRuntimeState {
  const connectionState =
    previous.connectionState === "idle"
      ? "connecting"
      : previous.connectionState === "disconnected"
        ? "reconnecting"
        : previous.connectionState;

  return {
    ...previous,
    connectionState,
    connectionError: null,
  };
}

function isAwaitingShellSnapshot(state: EnvironmentRuntimeState): boolean {
  return state.connectionState === "connecting" || state.connectionState === "reconnecting";
}

export interface ShellResumeWatchdog {
  readonly schedule: () => void;
  readonly markShellSnapshotSynced: () => void;
  readonly cancel: () => void;
}

export interface ShellResumeWatchdogOptions {
  readonly timeoutMs: number;
  readonly getRuntimeState: () => EnvironmentRuntimeState;
  readonly markPending: () => void;
  readonly onTimeout: () => void;
}

export function createShellResumeWatchdog(
  options: ShellResumeWatchdogOptions,
): ShellResumeWatchdog {
  let timer: TimerHandle | null = null;
  let generation = 0;

  const clearCurrentTimer = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  return {
    schedule: () => {
      generation += 1;
      const scheduledGeneration = generation;
      clearCurrentTimer();
      options.markPending();
      timer = setTimeout(() => {
        timer = null;
        if (scheduledGeneration !== generation) {
          return;
        }

        if (!isAwaitingShellSnapshot(options.getRuntimeState())) {
          return;
        }

        options.onTimeout();
      }, options.timeoutMs);
    },
    markShellSnapshotSynced: () => {
      generation += 1;
      clearCurrentTimer();
    },
    cancel: () => {
      generation += 1;
      clearCurrentTimer();
    },
  };
}
