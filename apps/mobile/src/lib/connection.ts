import { EnvironmentId } from "@t3tools/contracts";
import {
  bootstrapRemoteBearerSession,
  fetchRemoteEnvironmentDescriptor,
  resolveRemotePairingTarget,
} from "@t3tools/shared/remote";
import { recordMobileDiagnostic } from "./mobileDiagnostics";

export interface RemoteConnectionInput {
  readonly pairingUrl: string;
}

export interface SavedRemoteConnection {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly pairingUrl: string;
  readonly displayUrl: string;
  readonly httpBaseUrl: string;
  readonly wsBaseUrl: string;
  readonly bearerToken: string;
}

export type RemoteClientConnectionState =
  | "idle"
  | "connecting"
  | "ready"
  | "reconnecting"
  | "disconnected";

export async function bootstrapRemoteConnection(
  input: RemoteConnectionInput,
): Promise<SavedRemoteConnection> {
  recordMobileDiagnostic({
    level: "info",
    tag: "mobile.pairing.target.resolve.start",
    data: { pairingUrl: input.pairingUrl },
  });

  let target: ReturnType<typeof resolveRemotePairingTarget>;
  try {
    target = resolveRemotePairingTarget({
      pairingUrl: input.pairingUrl,
    });
    recordMobileDiagnostic({
      level: "info",
      tag: "mobile.pairing.target.resolve.success",
      data: {
        httpBaseUrl: target.httpBaseUrl,
        wsBaseUrl: target.wsBaseUrl,
        credentialPresent: target.credential.length > 0,
      },
    });
  } catch (error) {
    recordMobileDiagnostic({
      level: "error",
      tag: "mobile.pairing.target.resolve.error",
      message: error instanceof Error ? error.message : "Failed to resolve pairing target.",
      data: { pairingUrl: input.pairingUrl },
    });
    throw error;
  }

  recordMobileDiagnostic({
    level: "info",
    tag: "mobile.pairing.descriptor.fetch.start",
    data: { httpBaseUrl: target.httpBaseUrl },
  });
  let descriptor: Awaited<ReturnType<typeof fetchRemoteEnvironmentDescriptor>>;
  try {
    descriptor = await fetchRemoteEnvironmentDescriptor({
      httpBaseUrl: target.httpBaseUrl,
    });
    recordMobileDiagnostic({
      level: "info",
      tag: "mobile.pairing.descriptor.fetch.success",
      data: {
        httpBaseUrl: target.httpBaseUrl,
        environmentId: descriptor.environmentId,
        label: descriptor.label,
      },
    });
  } catch (error) {
    recordMobileDiagnostic({
      level: "error",
      tag: "mobile.pairing.descriptor.fetch.error",
      message:
        error instanceof Error ? error.message : "Failed to fetch remote environment descriptor.",
      data: { httpBaseUrl: target.httpBaseUrl },
    });
    throw error;
  }

  recordMobileDiagnostic({
    level: "info",
    tag: "mobile.pairing.bearer.bootstrap.start",
    data: { httpBaseUrl: target.httpBaseUrl, credentialPresent: target.credential.length > 0 },
  });
  let bootstrap: Awaited<ReturnType<typeof bootstrapRemoteBearerSession>>;
  try {
    bootstrap = await bootstrapRemoteBearerSession({
      httpBaseUrl: target.httpBaseUrl,
      credential: target.credential,
    });
    recordMobileDiagnostic({
      level: "info",
      tag: "mobile.pairing.bearer.bootstrap.success",
      data: {
        httpBaseUrl: target.httpBaseUrl,
        bearerTokenPresent: bootstrap.sessionToken.length > 0,
      },
    });
  } catch (error) {
    recordMobileDiagnostic({
      level: "error",
      tag: "mobile.pairing.bearer.bootstrap.error",
      message: error instanceof Error ? error.message : "Failed to bootstrap bearer session.",
      data: { httpBaseUrl: target.httpBaseUrl },
    });
    throw error;
  }

  return {
    environmentId: descriptor.environmentId,
    environmentLabel: descriptor.label,
    pairingUrl: input.pairingUrl.trim(),
    displayUrl: target.httpBaseUrl,
    httpBaseUrl: target.httpBaseUrl,
    wsBaseUrl: target.wsBaseUrl,
    bearerToken: bootstrap.sessionToken,
  };
}
