import type { ServerConfig } from "@t3tools/contracts";

import { compareT3Versions } from "~/versionSkew";

import type {
  SavedEnvironmentConnectionState,
  SavedEnvironmentRecord,
  SavedEnvironmentRuntimeState,
} from "./catalog";

export type RemoteUpgradeEligibility =
  | {
      readonly available: true;
      readonly reason: "desktopSsh" | "remoteHttp";
      readonly serverVersion: string;
      readonly clientVersion: string;
    }
  | {
      readonly available: false;
      readonly reason:
        | "notRemote"
        | "noServerConfig"
        | "clientNotNewer"
        | "unsupportedPlatform"
        | "noOutOfBandPath"
        | "connecting";
    };

function normalizeVersion(version: string | null | undefined): string | null {
  const trimmed = version?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : null;
}

function isLinuxServerConfig(serverConfig: Pick<ServerConfig, "environment">): boolean {
  return serverConfig.environment.platform?.os === "linux";
}

export function resolveRemoteUpgradeEligibility(input: {
  readonly environmentRecord: SavedEnvironmentRecord | null;
  readonly runtime: SavedEnvironmentRuntimeState | null;
  readonly connectionState: SavedEnvironmentConnectionState | null;
  readonly clientVersion: string;
  readonly hasBearerToken?: boolean | null;
}): RemoteUpgradeEligibility {
  if (!input.environmentRecord) {
    return { available: false, reason: "notRemote" };
  }
  if (input.connectionState === "connecting") {
    return { available: false, reason: "connecting" };
  }

  const serverConfig = input.runtime?.serverConfig ?? null;
  if (!serverConfig) {
    return { available: false, reason: "noServerConfig" };
  }
  if (!isLinuxServerConfig(serverConfig)) {
    return { available: false, reason: "unsupportedPlatform" };
  }

  const clientVersion = normalizeVersion(input.clientVersion);
  const serverVersion = normalizeVersion(serverConfig.environment.serverVersion);
  if (!clientVersion || !serverVersion || compareT3Versions(clientVersion, serverVersion) <= 0) {
    return { available: false, reason: "clientNotNewer" };
  }

  if (input.environmentRecord.desktopSsh) {
    return {
      available: true,
      reason: "desktopSsh",
      serverVersion,
      clientVersion,
    };
  }

  if (input.environmentRecord.httpBaseUrl && input.hasBearerToken === true) {
    return {
      available: true,
      reason: "remoteHttp",
      serverVersion,
      clientVersion,
    };
  }

  return { available: false, reason: "noOutOfBandPath" };
}
