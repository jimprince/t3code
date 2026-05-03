import Constants from "expo-constants";
import * as Updates from "expo-updates";

import type { EnvironmentId } from "@t3tools/contracts";

import {
  getMobileDiagnosticTail,
  type MobileDiagnosticEvent,
  writeMobileDiagnosticsSnapshot,
} from "../../lib/mobileDiagnostics";
import { environmentRuntimeManager } from "../../state/use-environment-runtime";
import {
  getSavedConnectionsSnapshot,
  useRemoteEnvironmentState,
} from "../../state/use-remote-environment-registry";
import { shellSnapshotManager, useShellSnapshotStates } from "../../state/use-shell-snapshot";

export interface MobileDebugSnapshot {
  readonly generatedAt: string;
  readonly app: {
    readonly variant: string;
    readonly bundleIdentifier?: string;
    readonly scheme?: string;
    readonly runtimeVersion?: string | null;
    readonly updateId?: string | null;
    readonly channel?: string | null;
  };
  readonly savedConnections: ReadonlyArray<{
    readonly environmentId: string;
    readonly label: string;
    readonly displayUrl: string;
    readonly httpBaseUrl: string;
    readonly wsBaseUrl: string;
    readonly bearerTokenPresent: boolean;
  }>;
  readonly runtime: ReadonlyArray<{
    readonly environmentId: string;
    readonly state: string;
    readonly error?: string;
    readonly shellSnapshotPending: boolean;
    readonly shellSnapshotLoaded: boolean;
    readonly shellSnapshotError?: string;
    readonly projectCount: number;
    readonly threadCount: number;
  }>;
  readonly diagnosticsTail: ReadonlyArray<MobileDiagnosticEvent>;
}

function getExtra(): {
  readonly appVariant?: string;
  readonly bundleIdentifier?: string;
  readonly scheme?: string;
} {
  return (Constants.expoConfig?.extra ?? {}) as {
    readonly appVariant?: string;
    readonly bundleIdentifier?: string;
    readonly scheme?: string;
  };
}

export function getMobileDebugSnapshot(): MobileDebugSnapshot {
  const extra = getExtra();
  const savedConnections = Object.values(getSavedConnectionsSnapshot());

  return {
    generatedAt: new Date().toISOString(),
    app: {
      variant: extra.appVariant ?? "unknown",
      bundleIdentifier: extra.bundleIdentifier ?? Constants.expoConfig?.ios?.bundleIdentifier,
      scheme: extra.scheme ?? String(Constants.expoConfig?.scheme ?? ""),
      runtimeVersion: Updates.runtimeVersion ?? null,
      updateId: Updates.updateId ?? null,
      channel: Updates.channel ?? null,
    },
    savedConnections: savedConnections.map((connection) => ({
      environmentId: connection.environmentId,
      label: connection.environmentLabel,
      displayUrl: connection.displayUrl,
      httpBaseUrl: connection.httpBaseUrl,
      wsBaseUrl: connection.wsBaseUrl,
      bearerTokenPresent: connection.bearerToken.trim().length > 0,
    })),
    runtime: savedConnections.map((connection) => {
      const environmentId = connection.environmentId as EnvironmentId;
      const runtime = environmentRuntimeManager.getSnapshot({ environmentId });
      const shellSnapshot = shellSnapshotManager.getSnapshot({ environmentId });
      return {
        environmentId,
        state: runtime.connectionState,
        ...(runtime.connectionError ? { error: runtime.connectionError } : {}),
        shellSnapshotPending: shellSnapshot.isPending,
        shellSnapshotLoaded: shellSnapshot.data !== null,
        ...(shellSnapshot.error ? { shellSnapshotError: shellSnapshot.error } : {}),
        projectCount: shellSnapshot.data?.projects.length ?? 0,
        threadCount: shellSnapshot.data?.threads.length ?? 0,
      };
    }),
    diagnosticsTail: getMobileDiagnosticTail(),
  };
}

export async function writeMobileDebugSnapshot(): Promise<{
  readonly uri: string;
  readonly snapshot: MobileDebugSnapshot;
}> {
  const snapshot = getMobileDebugSnapshot();
  const uri = await writeMobileDiagnosticsSnapshot(snapshot);
  return { uri, snapshot };
}

export function useMobileDebugSnapshotInputs() {
  const { savedConnectionsById } = useRemoteEnvironmentState();
  useShellSnapshotStates(Object.keys(savedConnectionsById) as EnvironmentId[]);
}
