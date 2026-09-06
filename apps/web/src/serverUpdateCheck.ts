import type {
  ServerConfig,
  ServerHeadlessUpdateCheckInput,
  ServerHeadlessUpdateCheckResult,
} from "@t3tools/contracts";

import { APP_VERSION } from "./branding";
import { isClientVersionNewerThanServer } from "./versionSkew";

export function buildHeadlessUpdateCheckRequest(
  serverConfig: Pick<ServerConfig, "environment">,
): ServerHeadlessUpdateCheckInput | null {
  const serverVersion = serverConfig.environment.serverVersion;
  if (
    serverConfig.environment.platform?.os !== "linux" ||
    !isClientVersionNewerThanServer(serverVersion)
  ) {
    return null;
  }

  return {
    clientVersion: APP_VERSION,
    serverVersion,
  };
}

export interface HeadlessUpdateCheckOutcome {
  readonly state: "requested" | "unavailable" | "failed";
  readonly toastType: "success" | "info" | "error";
  readonly title: string;
  readonly description: string;
}

export function resolveHeadlessUpdateCheckOutcome(
  result: ServerHeadlessUpdateCheckResult,
): HeadlessUpdateCheckOutcome {
  switch (result.status) {
    case "queued":
      return {
        state: "requested",
        toastType: "success",
        title: "Remote upgrade requested",
        description:
          result.message ?? "The remote updater is checking, staging, and validating the release.",
      };
    case "cooldown":
      return {
        state: "requested",
        toastType: "info",
        title: "Remote upgrade already requested",
        description: result.message ?? "A recent remote upgrade request is already being handled.",
      };
    case "unsupported":
      return {
        state: "unavailable",
        toastType: "error",
        title: "Remote upgrade unavailable",
        description:
          result.message ?? "This server does not have the headless upgrade service installed.",
      };
    case "error":
      return {
        state: "failed",
        toastType: "error",
        title: "Could not start remote upgrade",
        description: result.message ?? "The remote upgrade service could not be started.",
      };
  }
}
