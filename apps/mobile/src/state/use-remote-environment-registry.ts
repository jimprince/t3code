import { useAtomValue } from "@effect/atom-react";
import { useCallback, useEffect, useMemo } from "react";
import { Alert } from "react-native";

import {
  type EnvironmentRuntimeState,
  createEnvironmentConnection,
  createKnownEnvironment,
  createWsRpcClient,
  EnvironmentConnectionState,
  WsTransport,
} from "@t3tools/client-runtime";
import type { EnvironmentId } from "@t3tools/contracts";
import { resolveRemoteWebSocketConnectionUrl } from "@t3tools/shared/remote";
import * as Arr from "effect/Array";
import * as Order from "effect/Order";
import * as Option from "effect/Option";
import { pipe } from "effect/Function";
import { Atom } from "effect/unstable/reactivity";
import { type SavedRemoteConnection, bootstrapRemoteConnection } from "../lib/connection";
import { recordMobileDiagnostic } from "../lib/mobileDiagnostics";
import { terminalDebugLog } from "../features/terminal/terminalDebugLog";
import {
  clearCachedShellSnapshot,
  clearSavedConnection,
  clearSavedConnections,
  loadCachedShellSnapshot,
  loadSavedConnections,
  saveCachedShellSnapshot,
  saveConnection,
} from "../lib/storage";
import { appAtomRegistry } from "./atom-registry";
import {
  drainEnvironmentSessions,
  notifyEnvironmentConnectionListeners,
  removeEnvironmentSession,
  setEnvironmentSession,
} from "./environment-session-registry";
import { type ConnectedEnvironmentSummary } from "./remote-runtime-types";
import {
  invalidateSourceControlDiscoveryForEnvironment,
  resetSourceControlDiscoveryState,
} from "./use-source-control-discovery";
import { environmentRuntimeManager, useEnvironmentRuntimeStates } from "./use-environment-runtime";
import {
  clearCachedShellSnapshotMetadata,
  hydrateCachedShellSnapshot,
  markShellSnapshotLive,
  shellSnapshotManager,
} from "./use-shell-snapshot";
import { subscribeTerminalMetadata, terminalSessionManager } from "./use-terminal-session";

const terminalMetadataUnsubscribers = new Map<EnvironmentId, () => void>();
const SAVED_CONNECTION_BOOTSTRAP_TIMEOUT_MS = 8_000;

interface RemoteEnvironmentLocalState {
  readonly isLoadingSavedConnection: boolean;
  readonly connectionPairingUrl: string;
  readonly pendingConnectionError: string | null;
  readonly savedConnectionsById: Record<EnvironmentId, SavedRemoteConnection>;
}

const isLoadingSavedConnectionAtom = Atom.make(true).pipe(
  Atom.keepAlive,
  Atom.withLabel("mobile:is-loading-saved-connection"),
);

const connectionPairingUrlAtom = Atom.make("").pipe(
  Atom.keepAlive,
  Atom.withLabel("mobile:connection-pairing-url"),
);

const pendingConnectionErrorAtom = Atom.make<string | null>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("mobile:pending-connection-error"),
);

const savedConnectionsByIdAtom = Atom.make<Record<EnvironmentId, SavedRemoteConnection>>({}).pipe(
  Atom.keepAlive,
  Atom.withLabel("mobile:saved-connections"),
);

function getSavedConnectionsById(): Record<EnvironmentId, SavedRemoteConnection> {
  return appAtomRegistry.get(savedConnectionsByIdAtom);
}

export function getSavedConnectionsSnapshot(): Record<EnvironmentId, SavedRemoteConnection> {
  return getSavedConnectionsById();
}

function setIsLoadingSavedConnection(value: boolean): void {
  appAtomRegistry.set(isLoadingSavedConnectionAtom, value);
}

function setConnectionPairingUrl(pairingUrl: string): void {
  appAtomRegistry.set(connectionPairingUrlAtom, pairingUrl);
}

function clearConnectionPairingUrl(): void {
  appAtomRegistry.set(connectionPairingUrlAtom, "");
}

export function setPendingConnectionError(message: string | null): void {
  appAtomRegistry.set(pendingConnectionErrorAtom, message);
}

function clearPendingConnectionError(): void {
  appAtomRegistry.set(pendingConnectionErrorAtom, null);
}

function replaceSavedConnections(connections: Record<EnvironmentId, SavedRemoteConnection>): void {
  appAtomRegistry.set(savedConnectionsByIdAtom, connections);
}

function upsertSavedConnection(connection: SavedRemoteConnection): void {
  const current = appAtomRegistry.get(savedConnectionsByIdAtom);
  appAtomRegistry.set(savedConnectionsByIdAtom, {
    ...current,
    [connection.environmentId]: connection,
  });
}

function removeSavedConnection(environmentId: EnvironmentId): void {
  const current = appAtomRegistry.get(savedConnectionsByIdAtom);
  const next = { ...current };
  delete next[environmentId];
  appAtomRegistry.set(savedConnectionsByIdAtom, next);
}

function useRemoteEnvironmentLocalState(): RemoteEnvironmentLocalState {
  const isLoadingSavedConnection = useAtomValue(isLoadingSavedConnectionAtom);
  const connectionPairingUrl = useAtomValue(connectionPairingUrlAtom);
  const pendingConnectionError = useAtomValue(pendingConnectionErrorAtom);
  const savedConnectionsById = useAtomValue(savedConnectionsByIdAtom);

  return useMemo(
    () => ({
      isLoadingSavedConnection,
      connectionPairingUrl,
      pendingConnectionError,
      savedConnectionsById,
    }),
    [connectionPairingUrl, isLoadingSavedConnection, pendingConnectionError, savedConnectionsById],
  );
}

function setEnvironmentConnectionStatus(
  environmentId: EnvironmentId,
  state: ConnectedEnvironmentSummary["connectionState"],
  error?: string | null,
) {
  environmentRuntimeManager.patch({ environmentId }, (current) => ({
    ...current,
    connectionState: state,
    connectionError: error === undefined ? current.connectionError : error,
  }));
}

function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  timeoutMessage: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      reject(new Error(timeoutMessage));
    }, timeoutMs);

    promise.then(
      (value) => {
        clearTimeout(timeoutId);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timeoutId);
        reject(error);
      },
    );
  });
}

export async function disconnectEnvironment(
  environmentId: EnvironmentId,
  options?: { readonly preserveShellSnapshot?: boolean; readonly removeSaved?: boolean },
) {
  recordMobileDiagnostic({
    level: "info",
    tag: "mobile.connection.saved.disconnect.start",
    data: { environmentId, removeSaved: options?.removeSaved ?? false },
  });
  const session = removeEnvironmentSession(environmentId);
  notifyEnvironmentConnectionListeners();
  await session?.connection.dispose();
  terminalMetadataUnsubscribers.get(environmentId)?.();
  terminalMetadataUnsubscribers.delete(environmentId);
  if (!options?.preserveShellSnapshot) {
    shellSnapshotManager.invalidate({ environmentId });
  }
  invalidateSourceControlDiscoveryForEnvironment(environmentId);
  terminalSessionManager.invalidateEnvironment(environmentId);
  environmentRuntimeManager.invalidate({ environmentId });

  if (options?.removeSaved) {
    await clearSavedConnection(environmentId);
    await clearCachedShellSnapshot(environmentId);
    clearCachedShellSnapshotMetadata(environmentId);
    removeSavedConnection(environmentId);
  }
  recordMobileDiagnostic({
    level: "info",
    tag: "mobile.connection.saved.disconnect.end",
    data: { environmentId, removeSaved: options?.removeSaved ?? false },
  });
}

export async function disconnectAllEnvironments(options?: { readonly removeSaved?: boolean }) {
  const environmentIds = [
    ...new Set([
      ...terminalMetadataUnsubscribers.keys(),
      ...Object.keys(getSavedConnectionsById()),
    ]),
  ] as EnvironmentId[];

  await Promise.all(
    environmentIds.map((environmentId) =>
      disconnectEnvironment(environmentId, {
        removeSaved: options?.removeSaved,
      }),
    ),
  );

  if (options?.removeSaved) {
    await clearSavedConnections();
    replaceSavedConnections({});
  }
}

export async function connectSavedEnvironment(
  connection: SavedRemoteConnection,
  options?: { readonly persist?: boolean },
) {
  recordMobileDiagnostic({
    level: "info",
    tag: "mobile.connection.saved.connect.start",
    data: {
      environmentId: connection.environmentId,
      environmentLabel: connection.environmentLabel,
      httpBaseUrl: connection.httpBaseUrl,
      wsBaseUrl: connection.wsBaseUrl,
      persist: options?.persist !== false,
      bearerTokenPresent: connection.bearerToken.length > 0,
    },
  });
  await disconnectEnvironment(connection.environmentId, { preserveShellSnapshot: true });

  if (options?.persist !== false) {
    await saveConnection(connection);
  }

  upsertSavedConnection(connection);
  setEnvironmentConnectionStatus(connection.environmentId, "connecting", null);
  recordMobileDiagnostic({
    level: "info",
    tag: "mobile.connection.saved.connect.state",
    data: { environmentId: connection.environmentId, state: "connecting" },
  });
  shellSnapshotManager.markPending({ environmentId: connection.environmentId });

  const transport = new WsTransport(
    async () => {
      recordMobileDiagnostic({
        level: "info",
        tag: "mobile.ws.token.start",
        data: {
          environmentId: connection.environmentId,
          httpBaseUrl: connection.httpBaseUrl,
          wsBaseUrl: connection.wsBaseUrl,
          bearerTokenPresent: connection.bearerToken.length > 0,
        },
      });
      try {
        const url = await resolveRemoteWebSocketConnectionUrl({
          wsBaseUrl: connection.wsBaseUrl,
          httpBaseUrl: connection.httpBaseUrl,
          bearerToken: connection.bearerToken,
        });
        recordMobileDiagnostic({
          level: "info",
          tag: "mobile.ws.token.success",
          data: { environmentId: connection.environmentId, socketUrl: url },
        });
        return url;
      } catch (error) {
        recordMobileDiagnostic({
          level: "error",
          tag: "mobile.ws.token.error",
          message: error instanceof Error ? error.message : "Failed to mint WebSocket token.",
          data: {
            environmentId: connection.environmentId,
            httpBaseUrl: connection.httpBaseUrl,
            wsBaseUrl: connection.wsBaseUrl,
          },
        });
        throw error;
      }
    },
    {
      onAttempt: (socketUrl) => {
        recordMobileDiagnostic({
          level: "info",
          tag: "mobile.ws.attempt",
          data: { environmentId: connection.environmentId, socketUrl },
        });
        environmentRuntimeManager.patch({ environmentId: connection.environmentId }, (previous) => {
          const nextState =
            previous.connectionState === "ready" || previous.connectionState === "reconnecting"
              ? "reconnecting"
              : "connecting";
          const keepSettledFailure =
            previous.connectionState === "disconnected" && previous.connectionError !== null;
          return {
            ...previous,
            connectionState: keepSettledFailure ? "disconnected" : nextState,
            connectionError: keepSettledFailure ? previous.connectionError : null,
          };
        });
      },
      onOpen: () => {
        recordMobileDiagnostic({
          level: "info",
          tag: "mobile.ws.open",
          data: { environmentId: connection.environmentId },
        });
      },
      onError: (message) => {
        recordMobileDiagnostic({
          level: "error",
          tag: "mobile.ws.error",
          message,
          data: { environmentId: connection.environmentId },
        });
        setEnvironmentConnectionStatus(connection.environmentId, "disconnected", message);
      },
      onClose: (details) => {
        recordMobileDiagnostic({
          level: details.code === 1000 ? "info" : "warn",
          tag: "mobile.ws.close",
          data: {
            environmentId: connection.environmentId,
            code: details.code,
            reason: details.reason,
          },
        });
        const reason =
          details.reason.trim().length > 0
            ? details.reason
            : details.code === 1000
              ? null
              : `Remote connection closed (${details.code}).`;
        setEnvironmentConnectionStatus(connection.environmentId, "disconnected", reason);
      },
    },
  );

  const client = createWsRpcClient(transport);
  const environmentConnection = createEnvironmentConnection({
    kind: "saved",
    knownEnvironment: {
      ...createKnownEnvironment({
        id: connection.environmentId,
        label: connection.environmentLabel,
        source: "manual",
        target: {
          httpBaseUrl: connection.httpBaseUrl,
          wsBaseUrl: connection.wsBaseUrl,
        },
      }),
      environmentId: connection.environmentId,
    },
    client,
    applyShellEvent: (event, environmentId) => {
      recordMobileDiagnostic({
        level: "debug",
        tag: "mobile.rpc.subscribe.shell.event",
        data: { environmentId, eventKind: event.kind },
      });
      shellSnapshotManager.applyEvent({ environmentId }, event);
    },
    syncShellSnapshot: (snapshot, environmentId) => {
      recordMobileDiagnostic({
        level: "info",
        tag: "mobile.rpc.subscribe.shell.snapshot",
        data: {
          environmentId,
          projectCount: snapshot.projects.length,
          threadCount: snapshot.threads.length,
        },
      });
      shellSnapshotManager.syncSnapshot({ environmentId }, snapshot);
      markShellSnapshotLive(environmentId);
      void saveCachedShellSnapshot(environmentId, snapshot);
      environmentRuntimeManager.patch({ environmentId }, (runtime) => ({
        ...runtime,
        connectionState: "ready",
        connectionError: null,
      }));
    },
    onShellResubscribe: (environmentId) => {
      recordMobileDiagnostic({
        level: "info",
        tag: "mobile.rpc.subscribe.shell.resubscribe",
        data: { environmentId },
      });
      shellSnapshotManager.markPending({ environmentId });
    },
    onConfigSnapshot: (serverConfig) => {
      recordMobileDiagnostic({
        level: "info",
        tag: "mobile.rpc.subscribe.config.snapshot",
        data: { environmentId: connection.environmentId },
      });
      environmentRuntimeManager.patch({ environmentId: connection.environmentId }, (runtime) => ({
        ...runtime,
        serverConfig,
      }));
    },
  });

  setEnvironmentSession(connection.environmentId, {
    client,
    connection: environmentConnection,
  });
  notifyEnvironmentConnectionListeners();

  try {
    recordMobileDiagnostic({
      level: "info",
      tag: "mobile.rpc.subscribe.shell.start",
      data: { environmentId: connection.environmentId },
    });
    await withTimeout(
      environmentConnection.ensureBootstrapped(),
      SAVED_CONNECTION_BOOTSTRAP_TIMEOUT_MS,
      "Environment did not respond before the connection timeout.",
    );
    recordMobileDiagnostic({
      level: "info",
      tag: "mobile.connection.saved.connect.state",
      data: { environmentId: connection.environmentId, state: "ready" },
    });
    try {
      recordMobileDiagnostic({
        level: "info",
        tag: "mobile.rpc.subscribe.terminalMetadata.start",
        data: { environmentId: connection.environmentId },
      });
      terminalMetadataUnsubscribers.set(
        connection.environmentId,
        subscribeTerminalMetadata({
          environmentId: connection.environmentId,
          client,
          options: {
            onError: (message) => {
              recordMobileDiagnostic({
                level: "warn",
                tag: "mobile.rpc.subscribe.terminalMetadata.error",
                message,
                data: { environmentId: connection.environmentId },
              });
            },
          },
        }),
      );
      terminalDebugLog("registry:terminal-metadata-subscribed", {
        environmentId: connection.environmentId,
      });
    } catch (error) {
      recordMobileDiagnostic({
        level: "warn",
        tag: "mobile.rpc.subscribe.terminalMetadata.error",
        message:
          error instanceof Error
            ? error.message
            : "Failed to subscribe to terminal metadata; shell snapshot remains authoritative.",
        data: { environmentId: connection.environmentId },
      });
    }
  } catch (error) {
    recordMobileDiagnostic({
      level: "error",
      tag: "mobile.rpc.subscribe.shell.error",
      message: error instanceof Error ? error.message : "Failed to bootstrap remote connection.",
      data: { environmentId: connection.environmentId },
    });
    setEnvironmentConnectionStatus(
      connection.environmentId,
      "disconnected",
      error instanceof Error ? error.message : "Failed to bootstrap remote connection.",
    );
  }
}

const environmentsSortOrder = Order.mapInput(
  Order.Struct({
    environmentLabel: Order.String,
  }),
  (environment: ConnectedEnvironmentSummary) => ({
    environmentLabel: environment.environmentLabel,
  }),
);

function deriveConnectedEnvironments(
  savedConnectionsById: Record<string, SavedRemoteConnection>,
  environmentStateById: Record<EnvironmentId, EnvironmentRuntimeState>,
): ReadonlyArray<ConnectedEnvironmentSummary> {
  return Arr.sort(
    Object.values(savedConnectionsById).map((connection) => {
      const runtime = environmentStateById[connection.environmentId];
      return {
        environmentId: connection.environmentId,
        environmentLabel: connection.environmentLabel,
        displayUrl: connection.displayUrl,
        connectionState: runtime?.connectionState ?? "idle",
        connectionError: runtime?.connectionError ?? null,
      };
    }),
    environmentsSortOrder,
  );
}

export function useRemoteEnvironmentBootstrap() {
  useEffect(() => {
    let cancelled = false;

    recordMobileDiagnostic({
      level: "info",
      tag: "mobile.app.bootstrap.start",
    });
    recordMobileDiagnostic({
      level: "info",
      tag: "mobile.storage.loadSavedConnections.start",
    });
    void loadSavedConnections()
      .then((connections) => {
        if (cancelled) {
          return;
        }

        replaceSavedConnections(
          Object.fromEntries(
            connections.map((connection) => [connection.environmentId, connection]),
          ),
        );

        recordMobileDiagnostic({
          level: "info",
          tag: "mobile.storage.loadSavedConnections.end",
          data: { count: connections.length },
        });
        setIsLoadingSavedConnection(false);
        recordMobileDiagnostic({
          level: "info",
          tag: "mobile.app.bootstrap.end",
          data: { savedConnectionCount: connections.length },
        });

        void (async () => {
          await Promise.all(
            connections.map(async (connection) => {
              const cached = await loadCachedShellSnapshot(connection.environmentId);
              if (!cancelled && cached) {
                hydrateCachedShellSnapshot(cached);
              }
            }),
          );

          if (cancelled) {
            return;
          }

          await Promise.all(
            connections.map((connection) =>
              connectSavedEnvironment(connection, {
                persist: false,
              }),
            ),
          );
        })();
      })
      .catch((error) => {
        if (!cancelled) {
          recordMobileDiagnostic({
            level: "error",
            tag: "mobile.storage.loadSavedConnections.error",
            message:
              error instanceof Error ? error.message : "Failed to load saved remote connections.",
          });
          setIsLoadingSavedConnection(false);
          recordMobileDiagnostic({
            level: "warn",
            tag: "mobile.app.bootstrap.end",
            data: { savedConnectionCount: 0 },
          });
        }
      });

    return () => {
      cancelled = true;
      for (const session of drainEnvironmentSessions()) {
        void session.connection.dispose();
      }
      for (const unsubscribe of terminalMetadataUnsubscribers.values()) {
        unsubscribe();
      }
      terminalMetadataUnsubscribers.clear();
      environmentRuntimeManager.invalidate();
      shellSnapshotManager.invalidate();
      resetSourceControlDiscoveryState();
      terminalSessionManager.invalidate();
      notifyEnvironmentConnectionListeners();
    };
  }, []);
}

export function useRemoteEnvironmentState() {
  const state = useRemoteEnvironmentLocalState();
  const environmentStateById = useEnvironmentRuntimeStates(
    Object.values(state.savedConnectionsById).map((connection) => connection.environmentId),
  );

  return useMemo(
    () => ({
      ...state,
      environmentStateById,
    }),
    [environmentStateById, state],
  );
}

export function useRemoteConnectionStatus() {
  const { environmentStateById, pendingConnectionError, savedConnectionsById } =
    useRemoteEnvironmentState();

  const connectedEnvironments = useMemo(
    () => deriveConnectedEnvironments(savedConnectionsById, environmentStateById),
    [environmentStateById, savedConnectionsById],
  );

  const connectionState = useMemo<EnvironmentConnectionState>(() => {
    if (connectedEnvironments.length === 0) {
      return "idle";
    }
    if (connectedEnvironments.some((environment) => environment.connectionState === "ready")) {
      return "ready";
    }
    if (
      connectedEnvironments.some((environment) => environment.connectionState === "reconnecting")
    ) {
      return "reconnecting";
    }
    if (connectedEnvironments.some((environment) => environment.connectionState === "connecting")) {
      return "connecting";
    }
    return "disconnected";
  }, [connectedEnvironments]);

  const connectionError = useMemo(
    () =>
      pipe(
        Arr.appendAll(
          [pendingConnectionError],
          Arr.map(connectedEnvironments, (environment) => environment.connectionError),
        ),
        Arr.findFirst((value) => value !== null),
        Option.getOrNull,
      ),
    [connectedEnvironments, pendingConnectionError],
  );

  return {
    connectedEnvironments,
    connectionState,
    connectionError,
  };
}

export function useRemoteConnections() {
  const { connectionPairingUrl, pendingConnectionError } = useRemoteEnvironmentState();
  const { connectedEnvironments, connectionError, connectionState } = useRemoteConnectionStatus();

  const onConnectPress = useCallback(
    async (pairingUrl?: string) => {
      try {
        const nextPairingUrl = pairingUrl ?? connectionPairingUrl;
        const connection = await bootstrapRemoteConnection({ pairingUrl: nextPairingUrl });
        clearPendingConnectionError();
        await connectSavedEnvironment(connection);
        clearConnectionPairingUrl();
      } catch (error) {
        recordMobileDiagnostic({
          level: "error",
          tag: "mobile.pairing.connect.error",
          message: error instanceof Error ? error.message : "Failed to pair with the environment.",
        });
        setPendingConnectionError(
          error instanceof Error ? error.message : "Failed to pair with the environment.",
        );
        throw error;
      }
    },
    [connectionPairingUrl],
  );

  const onUpdateEnvironment = useCallback(
    async (
      environmentId: EnvironmentId,
      updates: { readonly label: string; readonly displayUrl: string },
    ) => {
      const connection = getSavedConnectionsById()[environmentId];
      if (!connection) {
        return;
      }

      const updated: SavedRemoteConnection = {
        ...connection,
        environmentLabel: updates.label.trim() || connection.environmentLabel,
        displayUrl: updates.displayUrl.trim() || connection.displayUrl,
      };

      await saveConnection(updated);
      upsertSavedConnection(updated);
    },
    [],
  );

  const onReconnectEnvironment = useCallback((environmentId: EnvironmentId) => {
    const connection = getSavedConnectionsById()[environmentId];
    if (!connection) {
      return;
    }
    void connectSavedEnvironment(connection, { persist: false });
  }, []);

  const onRemoveEnvironmentPress = useCallback((environmentId: EnvironmentId) => {
    const connection = getSavedConnectionsById()[environmentId];
    if (!connection) {
      return;
    }

    Alert.alert(
      "Remove environment?",
      `Disconnect and forget ${connection.environmentLabel} on this device.`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Remove",
          style: "destructive",
          onPress: () => {
            void disconnectEnvironment(environmentId, { removeSaved: true });
          },
        },
      ],
    );
  }, []);

  return {
    connectionPairingUrl,
    connectionState,
    connectionError,
    pairingConnectionError: pendingConnectionError,
    connectedEnvironments,
    connectedEnvironmentCount: connectedEnvironments.length,
    onChangeConnectionPairingUrl: setConnectionPairingUrl,
    onConnectPress,
    onReconnectEnvironment,
    onUpdateEnvironment,
    onRemoveEnvironmentPress,
  };
}

export async function pairRemoteEnvironment(input: {
  readonly pairingUrl: string;
  readonly replaceExisting?: boolean;
}): Promise<SavedRemoteConnection> {
  if (input.replaceExisting) {
    await disconnectAllEnvironments({ removeSaved: true });
  }
  const connection = await bootstrapRemoteConnection({ pairingUrl: input.pairingUrl });
  clearPendingConnectionError();
  await connectSavedEnvironment(connection);
  clearConnectionPairingUrl();
  return connection;
}
