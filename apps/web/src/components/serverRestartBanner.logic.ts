import type { ServerRestartState } from "@t3tools/client-runtime/fork/server-restart";
import type { ServerLifecycleStreamEvent } from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { AsyncResult, type Atom, type AtomRegistry } from "effect/unstable/reactivity";

/** How long "Server updated" stays before the banner clears itself. */
const SERVER_RESTART_DONE_VISIBLE_MS = 4_000;

export const SERVER_RESTART_STEPS = ["Installing", "Restarting", "Reconnecting"] as const;

export type ServerRestartBannerModel = {
  readonly tone: "progress" | "done" | "failed";
  readonly title: string;
  readonly detail: string | null;
  /** How many of SERVER_RESTART_STEPS are done; the next one is current. Null when steps do not apply. */
  readonly stepsDone: number | null;
  readonly manualUpdateCommand: string | null;
  readonly canRetry: boolean;
};

/** "fork.5" for a fork build version, else the version as published. */
function serverVersionName(version: string): string {
  return version.match(/-fork\.\d+$/)?.[0]?.slice(1) ?? version;
}

/**
 * What the banner says for one server's restart. Connection loss arms the state's deadline, so a
 * deadline means the server is already gone and the next step is reconnecting.
 */
export function describeServerRestart(
  state: ServerRestartState,
  serverLabel: string | null,
): ServerRestartBannerModel | null {
  if (state.status === "idle") return null;
  const prefix = serverLabel ? `${serverLabel}: ` : "";
  const target = serverVersionName(state.targetVersion);
  switch (state.status) {
    case "updating": {
      const reconnecting = state.deadline !== undefined;
      return {
        tone: "progress",
        title: reconnecting ? `${prefix}Server restarted` : `${prefix}Server updating to ${target}`,
        detail: reconnecting
          ? "reconnecting automatically"
          : `back in about ${Math.max(1, Math.round(state.etaSeconds))} s`,
        stepsDone: reconnecting ? 2 : state.phase === "installing" ? 0 : 1,
        manualUpdateCommand: null,
        canRetry: false,
      };
    }
    case "updated":
      return {
        tone: "done",
        title: `${prefix}Server updated to ${target}`,
        detail: null,
        stepsDone: null,
        manualUpdateCommand: null,
        canRetry: false,
      };
    case "back":
      return {
        tone: "done",
        title: `${prefix}Server is back on ${serverVersionName(state.serverVersion)}`,
        detail: null,
        stepsDone: null,
        manualUpdateCommand: null,
        canRetry: false,
      };
    case "failed":
      return {
        tone: "failed",
        title: `${prefix}${state.reason}`,
        detail: null,
        stepsDone: null,
        manualUpdateCommand: state.manualUpdateCommand ?? null,
        canRetry: state.failureKind !== "update",
      };
  }
}

/** Milliseconds until a finished restart should leave the screen, or null while it must stay. */
export function serverRestartClearDelayMs(state: ServerRestartState): number | null {
  return state.status === "updated" || state.status === "back"
    ? SERVER_RESTART_DONE_VISIBLE_MS
    : null;
}

/** Milliseconds until a lost server counts as not coming back, or null when no deadline is armed. */
export function serverRestartExpiryDelayMs(
  state: ServerRestartState,
  nowMs: number,
): number | null {
  return state.status === "updating" && state.deadline !== undefined
    ? Math.max(0, state.deadline - nowMs)
    : null;
}

/**
 * The server is reachable again while an update is still in progress: a blip or a hop during
 * the install, or the restarted server. The "did not come back" clock stops; the replayed
 * update event or the ready event decides what happens next.
 */
export function serverRestartReconnected(state: ServerRestartState): ServerRestartState {
  if (state.status !== "updating" || state.deadline === undefined) return state;
  const { deadline: _deadline, ...rest } = state;
  return rest;
}

/**
 * Keeps the lifecycle events that move a restart. A stream atom holds only the last event of
 * each chunk and the replay arrives as one chunk sorted by sequence, so after this filter that
 * last event is the newest ready or updating one, not a later welcome or migration notice.
 */
export const restartLifecycleEvents = <E, R>(
  events: Stream.Stream<ServerLifecycleStreamEvent, E, R>,
): Stream.Stream<ServerLifecycleStreamEvent, E, R> =>
  events.pipe(Stream.filter((event) => event.type === "ready" || event.type === "updating"));

/**
 * Hands every lifecycle event the atom receives to `apply`. `immediate` builds the atom, which
 * is what opens its stream: a bare listener never starts it and would never hear from the server.
 */
export function followServerRestartEvents<E>(
  registry: AtomRegistry.AtomRegistry,
  atom: Atom.Atom<AsyncResult.AsyncResult<ServerLifecycleStreamEvent, E>>,
  apply: (event: ServerLifecycleStreamEvent) => void,
): () => void {
  return registry.subscribe(
    atom,
    (result) => {
      const event = Option.getOrNull(AsyncResult.value(result));
      if (event !== null) apply(event);
    },
    { immediate: true },
  );
}
