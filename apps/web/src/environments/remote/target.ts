import { getPairingTokenFromUrl } from "../../pairingUrl";

const DEFAULT_LOCAL_T3_BACKEND_PORT = "3773";

export interface ResolvedRemotePairingTarget {
  readonly credential: string;
  readonly httpBaseUrl: string;
  readonly wsBaseUrl: string;
}

function isPrivateIpv4Address(hostname: string): boolean {
  const parts = hostname.split(".");
  if (parts.length !== 4) {
    return false;
  }

  const octets = parts.map((part) => Number.parseInt(part, 10));
  if (
    octets.some((octet, index) => !/^\d+$/.test(parts[index] ?? "") || octet < 0 || octet > 255)
  ) {
    return false;
  }

  const [first = 0, second = 0] = octets;
  return (
    first === 10 ||
    first === 127 ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168) ||
    (first === 169 && second === 254)
  );
}

function isLocalRemoteHost(hostname: string): boolean {
  const normalizedHostname = hostname.toLowerCase();
  return (
    normalizedHostname === "localhost" ||
    normalizedHostname.endsWith(".local") ||
    isPrivateIpv4Address(normalizedHostname)
  );
}

function normalizeRemoteBaseUrl(rawValue: string): URL {
  const trimmed = rawValue.trim();
  if (!trimmed) {
    throw new Error("Enter a backend URL.");
  }

  const normalizedInput =
    /^[a-zA-Z][a-zA-Z\d+-]*:\/\//.test(trimmed) || trimmed.startsWith("//")
      ? trimmed
      : `https://${trimmed}`;
  const url = new URL(normalizedInput, window.location.origin);
  if (isLocalRemoteHost(url.hostname) && url.port === "") {
    url.protocol = "http:";
    url.port = DEFAULT_LOCAL_T3_BACKEND_PORT;
  }
  url.pathname = "/";
  url.search = "";
  url.hash = "";
  return url;
}

function toHttpBaseUrl(url: URL): string {
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

function toWsBaseUrl(url: URL): string {
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

export function resolveRemotePairingTarget(input: {
  readonly pairingUrl?: string;
  readonly host?: string;
  readonly pairingCode?: string;
}): ResolvedRemotePairingTarget {
  const pairingUrl = input.pairingUrl?.trim() ?? "";
  if (pairingUrl.length > 0) {
    const url = new URL(pairingUrl, window.location.origin);
    const credential = getPairingTokenFromUrl(url) ?? "";
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
  const pairingCode = input.pairingCode?.trim() ?? "";
  if (!host) {
    throw new Error("Enter a backend URL.");
  }
  if (!pairingCode) {
    throw new Error("Enter a pairing code.");
  }

  const normalizedHost = normalizeRemoteBaseUrl(host);
  return {
    credential: pairingCode,
    httpBaseUrl: toHttpBaseUrl(normalizedHost),
    wsBaseUrl: toWsBaseUrl(normalizedHost),
  };
}
