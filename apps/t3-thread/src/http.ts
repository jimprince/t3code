import type {
  AuthAccessTokenResult,
  AuthSessionState,
  AuthWebSocketTicketResult,
  ExecutionEnvironmentDescriptor,
} from "./types.js";

const PAIRING_TOKEN_PARAM = "token";

// RFC 8693 OAuth token-exchange constants for the T3 environment bootstrap flow.
// The server replaced POST /api/auth/bootstrap/bearer with POST /oauth/token:
// a pairing credential (bootstrap token) is exchanged for a Bearer access token.
const TOKEN_EXCHANGE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:token-exchange";
const ENVIRONMENT_BOOTSTRAP_TOKEN_TYPE = "urn:t3:params:oauth:token-type:environment-bootstrap";
const ACCESS_TOKEN_TYPE = "urn:ietf:params:oauth:token-type:access_token";

function readHashParams(url: URL): URLSearchParams {
  return new URLSearchParams(url.hash.startsWith("#") ? url.hash.slice(1) : url.hash);
}

function getPairingTokenFromUrl(url: URL): string | null {
  const hashToken = readHashParams(url).get(PAIRING_TOKEN_PARAM)?.trim() ?? "";
  if (hashToken) {
    return hashToken;
  }

  const searchToken = url.searchParams.get(PAIRING_TOKEN_PARAM)?.trim() ?? "";
  return searchToken || null;
}

function normalizeRemoteBaseUrl(rawValue: string): URL {
  const trimmed = rawValue.trim();
  if (!trimmed) {
    throw new Error("Enter a backend URL.");
  }

  const normalizedInput =
    /^[a-zA-Z][a-zA-Z\d+.-]*:\/\//.test(trimmed) || trimmed.startsWith("//")
      ? trimmed
      : `https://${trimmed}`;
  const url = new URL(normalizedInput);
  url.pathname = "/";
  url.search = "";
  url.hash = "";
  return url;
}

export function toHttpBaseUrl(url: URL): string {
  const next = new URL(url.toString());
  if (next.protocol === "ws:") {
    next.protocol = "http:";
  } else if (next.protocol === "wss:") {
    next.protocol = "https:";
  }
  next.pathname = "/";
  next.search = "";
  next.hash = "";
  return next.toString();
}

export function toWsBaseUrl(url: URL): string {
  const next = new URL(url.toString());
  if (next.protocol === "http:") {
    next.protocol = "ws:";
  } else if (next.protocol === "https:") {
    next.protocol = "wss:";
  }
  next.pathname = "/";
  next.search = "";
  next.hash = "";
  return next.toString();
}

export function resolvePairingTarget(input: {
  pairingUrl?: string;
  host?: string;
  credential?: string;
}): { credential: string; httpBaseUrl: string; wsBaseUrl: string } {
  const pairingUrl = input.pairingUrl?.trim() ?? "";
  if (pairingUrl) {
    const url = new URL(pairingUrl);
    const credential = getPairingTokenFromUrl(url);
    if (!credential) {
      throw new Error("Pairing URL is missing its token.");
    }
    return {
      credential,
      httpBaseUrl: toHttpBaseUrl(url),
      wsBaseUrl: toWsBaseUrl(url),
    };
  }

  const host = input.host?.trim() ?? "";
  const credential = input.credential?.trim() ?? "";
  if (!host) {
    throw new Error("Enter a backend URL or pairing URL.");
  }
  if (!credential) {
    throw new Error("Enter a pairing code or use a pairing URL.");
  }

  const normalizedHost = normalizeRemoteBaseUrl(host);
  return {
    credential,
    httpBaseUrl: toHttpBaseUrl(normalizedHost),
    wsBaseUrl: toWsBaseUrl(normalizedHost),
  };
}

async function readErrorMessage(response: Response, fallback: string): Promise<string> {
  const text = await response.text();
  if (!text) {
    return fallback;
  }

  try {
    const parsed = JSON.parse(text) as { error?: string };
    if (typeof parsed.error === "string" && parsed.error.trim()) {
      return parsed.error;
    }
  } catch {
    // Fall through.
  }

  return text;
}

async function fetchRemoteJson<T>(input: {
  httpBaseUrl: string;
  pathname: string;
  method?: "GET" | "POST";
  bearerToken?: string;
  body?: unknown;
}): Promise<T> {
  const requestUrl = new URL(input.pathname, input.httpBaseUrl).toString();
  let response: Response;

  try {
    response = await fetch(requestUrl, {
      method: input.method ?? "GET",
      headers: {
        ...(input.body !== undefined ? { "content-type": "application/json" } : {}),
        ...(input.bearerToken ? { authorization: `Bearer ${input.bearerToken}` } : {}),
      },
      ...(input.body !== undefined ? { body: JSON.stringify(input.body) } : {}),
    });
  } catch (error) {
    throw new Error(
      `Failed to reach ${requestUrl} (${error instanceof Error ? error.message : String(error)}).`,
      { cause: error },
    );
  }

  if (!response.ok) {
    throw new Error(
      await readErrorMessage(response, `Remote request failed (${response.status}).`),
    );
  }

  return (await response.json()) as T;
}

export async function fetchEnvironmentDescriptor(
  httpBaseUrl: string,
): Promise<ExecutionEnvironmentDescriptor> {
  return fetchRemoteJson<ExecutionEnvironmentDescriptor>({
    httpBaseUrl,
    pathname: "/.well-known/t3/environment",
  });
}

export async function exchangePairingCredential(input: {
  httpBaseUrl: string;
  credential: string;
  clientLabel?: string;
}): Promise<AuthAccessTokenResult> {
  const requestUrl = new URL("/oauth/token", input.httpBaseUrl).toString();
  const form = new URLSearchParams({
    grant_type: TOKEN_EXCHANGE_GRANT_TYPE,
    subject_token: input.credential,
    subject_token_type: ENVIRONMENT_BOOTSTRAP_TOKEN_TYPE,
    requested_token_type: ACCESS_TOKEN_TYPE,
  });
  if (input.clientLabel) {
    form.set("client_label", input.clientLabel);
  }

  let response: Response;
  try {
    response = await fetch(requestUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    });
  } catch (error) {
    throw new Error(
      `Failed to reach ${requestUrl} (${error instanceof Error ? error.message : String(error)}).`,
      { cause: error },
    );
  }

  if (!response.ok) {
    throw new Error(
      await readErrorMessage(response, `Token exchange failed (${response.status}).`),
    );
  }

  return (await response.json()) as AuthAccessTokenResult;
}

export async function fetchSessionState(input: {
  httpBaseUrl: string;
  bearerToken: string;
}): Promise<AuthSessionState> {
  return fetchRemoteJson<AuthSessionState>({
    httpBaseUrl: input.httpBaseUrl,
    pathname: "/api/auth/session",
    bearerToken: input.bearerToken,
  });
}

export async function issueWebSocketTicket(input: {
  httpBaseUrl: string;
  bearerToken: string;
}): Promise<AuthWebSocketTicketResult> {
  return fetchRemoteJson<AuthWebSocketTicketResult>({
    httpBaseUrl: input.httpBaseUrl,
    pathname: "/api/auth/websocket-ticket",
    method: "POST",
    bearerToken: input.bearerToken,
  });
}

export async function resolveWebSocketUrl(input: {
  httpBaseUrl: string;
  wsBaseUrl: string;
  bearerToken: string;
}): Promise<string> {
  const issued = await issueWebSocketTicket({
    httpBaseUrl: input.httpBaseUrl,
    bearerToken: input.bearerToken,
  });
  const url = new URL(input.wsBaseUrl);
  url.pathname = "/ws";
  url.search = "";
  url.hash = "";
  url.searchParams.set("wsTicket", issued.ticket);
  return url.toString();
}
