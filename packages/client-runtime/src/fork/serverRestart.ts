import type { ServerLifecycleStreamEvent } from "@t3tools/contracts";

export const SERVER_RESTART_TIMEOUT_MS = 90_000;

type RestartDetails = {
  readonly targetVersion: string;
  readonly announcedAt: string;
  readonly manualUpdateCommand?: string;
  readonly deadline?: number;
};

export type ServerRestartState =
  | { readonly status: "idle" }
  | (RestartDetails & {
      readonly status: "updating";
      readonly phase: "installing" | "restarting";
      readonly etaSeconds: number;
    })
  | (RestartDetails & { readonly status: "back" | "updated"; readonly serverVersion: string })
  | (RestartDetails & { readonly status: "failed"; readonly reason: string });

/** Retain this state per environment across WebSocket reconnects. */
export function applyServerRestartEvent(
  state: ServerRestartState,
  event: ServerLifecycleStreamEvent,
): ServerRestartState {
  if (event.type === "updating") {
    const { at, phase, targetVersion, etaSeconds, manualUpdateCommand, reason } = event.payload;
    const details = {
      targetVersion,
      announcedAt: at,
      ...(manualUpdateCommand === undefined ? {} : { manualUpdateCommand }),
      ...(state.status === "updating" &&
      state.targetVersion === targetVersion &&
      state.deadline !== undefined
        ? { deadline: state.deadline }
        : {}),
    };
    return phase === "failed"
      ? { ...details, status: "failed", reason: reason ?? "Server update failed" }
      : { ...details, status: "updating", phase, etaSeconds };
  }
  if (
    event.type !== "ready" ||
    state.status === "idle" ||
    (state.status !== "updating" && state.status !== "failed") ||
    Date.parse(event.payload.at) <= Date.parse(state.announcedAt)
  )
    return state;
  const serverVersion = event.payload.environment.serverVersion;
  return {
    ...state,
    status: serverVersion === state.targetVersion ? "updated" : "back",
    serverVersion,
  };
}

/** Start the timeout at connection loss; a slow preparation is still connected. */
export function disconnectServerRestart(
  state: ServerRestartState,
  nowMs: number,
): ServerRestartState {
  return state.status === "updating" && state.deadline === undefined
    ? { ...state, deadline: nowMs + SERVER_RESTART_TIMEOUT_MS }
    : state;
}

export function expireServerRestart(state: ServerRestartState, nowMs: number): ServerRestartState {
  return state.status === "updating" && state.deadline !== undefined && nowMs >= state.deadline
    ? { ...state, status: "failed", reason: "Server did not come back" }
    : state;
}
