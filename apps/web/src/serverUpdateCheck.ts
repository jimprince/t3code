import type {
  EnvironmentId,
  ServerConfig,
  ServerHeadlessUpdateCheckInput,
  ServerHeadlessUpdateCheckResult,
} from "@t3tools/contracts";

import { APP_VERSION } from "./branding";
import { isClientVersionNewerThanServer } from "./versionSkew";

const HEADLESS_UPDATE_CHECK_REQUEST_COOLDOWN_MS = 30 * 60 * 1000;

const lastHeadlessUpdateCheckRequestByKey = new Map<string, number>();

function buildRequestKey(environmentId: EnvironmentId, serverVersion: string): string {
  return `${environmentId}:${APP_VERSION}:${serverVersion}`;
}

export function resetHeadlessUpdateCheckRequestsForTests(): void {
  lastHeadlessUpdateCheckRequestByKey.clear();
}

export function claimHeadlessUpdateCheckRequest(input: {
  readonly environmentId: EnvironmentId;
  readonly serverConfig: Pick<ServerConfig, "environment">;
  readonly nowMs?: number;
}): boolean {
  const serverVersion = input.serverConfig.environment.serverVersion;
  if (
    input.serverConfig.environment.platform?.os !== "linux" ||
    !isClientVersionNewerThanServer(serverVersion)
  ) {
    return false;
  }

  const nowMs = input.nowMs ?? Date.now();
  const key = buildRequestKey(input.environmentId, serverVersion);
  const lastRequestedAt = lastHeadlessUpdateCheckRequestByKey.get(key);
  if (
    lastRequestedAt !== undefined &&
    nowMs - lastRequestedAt < HEADLESS_UPDATE_CHECK_REQUEST_COOLDOWN_MS
  ) {
    return false;
  }

  lastHeadlessUpdateCheckRequestByKey.set(key, nowMs);
  return true;
}

export function maybeRequestHeadlessUpdateCheck(input: {
  readonly environmentId: EnvironmentId;
  readonly serverConfig: ServerConfig;
  readonly request: (
    request: ServerHeadlessUpdateCheckInput,
  ) => Promise<ServerHeadlessUpdateCheckResult>;
}): void {
  if (
    !claimHeadlessUpdateCheckRequest({
      environmentId: input.environmentId,
      serverConfig: input.serverConfig,
    })
  ) {
    return;
  }

  void input
    .request({
      clientVersion: APP_VERSION,
      serverVersion: input.serverConfig.environment.serverVersion,
    })
    .catch(() => undefined);
}
