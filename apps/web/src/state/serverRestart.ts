import {
  applyServerRestartEvent,
  disconnectServerRestart,
  expireServerRestart,
  type ServerRestartState,
} from "@t3tools/client-runtime/fork/server-restart";
import { createEnvironmentRpcSubscriptionAtomFamily } from "@t3tools/client-runtime/state/runtime";
import { type EnvironmentId, WS_METHODS } from "@t3tools/contracts";
import { useEffect } from "react";
import { create } from "zustand";

import {
  followServerRestartEvents,
  restartLifecycleEvents,
  serverRestartReconnected,
} from "../components/serverRestartBanner.logic";
import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { useEnvironments } from "./environments";

/** The server's ready and update events, newest one as the value. */
const serverLifecycleWithUpdates = createEnvironmentRpcSubscriptionAtomFamily(
  connectionAtomRuntime,
  {
    label: "environment-data:server:lifecycle-with-updates",
    tag: WS_METHODS.subscribeServerLifecycle,
    transform: restartLifecycleEvents,
  },
);

const IDLE: ServerRestartState = { status: "idle" };

/** One restart state per environment, kept across transport loss so the banner survives the restart. */
export const useServerRestartStore = create<{
  readonly dismissedAt: Readonly<Record<string, string>>;
  readonly byEnvironment: Readonly<Record<string, ServerRestartState>>;
}>(() => ({ byEnvironment: {}, dismissedAt: {} }));

function updateRestart(
  environmentId: EnvironmentId,
  next: (state: ServerRestartState) => ServerRestartState,
) {
  useServerRestartStore.setState(({ byEnvironment }) => {
    const current = byEnvironment[environmentId] ?? IDLE;
    const state = next(current);
    return state === current
      ? { byEnvironment }
      : { byEnvironment: { ...byEnvironment, [environmentId]: state } };
  });
}

// Environments connected right now; a connected server cannot have failed to come back.
const connectedEnvironments = new Set<string>();

export const expireRestart = (environmentId: EnvironmentId, nowMs: number) => {
  if (connectedEnvironments.has(environmentId)) return;
  updateRestart(environmentId, (state) => expireServerRestart(state, nowMs));
};

export const clearRestart = (environmentId: EnvironmentId) => {
  useServerRestartStore.setState(({ byEnvironment, dismissedAt }) => {
    const state = byEnvironment[environmentId];
    return {
      byEnvironment: { ...byEnvironment, [environmentId]: IDLE },
      dismissedAt:
        state && state.status !== "idle"
          ? { ...dismissedAt, [environmentId]: state.announcedAt }
          : dismissedAt,
    };
  });
};

/**
 * Feeds every environment's lifecycle events and connection loss into its restart state. Mount
 * once, above the banner, so a restart is tracked whichever page is open.
 */
export function useServerRestartTracking() {
  const { environments } = useEnvironments();
  const environmentIds = environments.map((environment) => environment.environmentId).join("\n");
  useEffect(() => {
    const unsubscribers = environmentIds
      .split("\n")
      .filter((id) => id.length > 0)
      .map((id) => {
        const environmentId = id as EnvironmentId;
        return followServerRestartEvents(
          appAtomRegistry,
          serverLifecycleWithUpdates({ environmentId, input: { includeUpdates: true } }),
          (event) =>
            updateRestart(environmentId, (state) =>
              applyServerRestartEvent(
                state,
                event,
                useServerRestartStore.getState().dismissedAt[environmentId],
              ),
            ),
        );
      });
    return () => unsubscribers.forEach((unsubscribe) => unsubscribe());
  }, [environmentIds]);

  // Only a lost connection starts the "did not come back" clock; installing is still connected,
  // and coming back (a blip during the install, or the restarted server) stops it again.
  const connectionKey = environments
    .map(
      (environment) =>
        `${environment.connection.phase === "connected" ? "1" : "0"}${environment.environmentId}`,
    )
    .join("\n");
  useEffect(() => {
    for (const entry of connectionKey.split("\n").filter((value) => value.length > 0)) {
      const id = entry.slice(1) as EnvironmentId;
      if (entry.startsWith("1")) {
        connectedEnvironments.add(id);
        updateRestart(id, serverRestartReconnected);
      } else {
        connectedEnvironments.delete(id);
        updateRestart(id, (state) => disconnectServerRestart(state, Date.now()));
      }
    }
  }, [connectionKey]);
}
