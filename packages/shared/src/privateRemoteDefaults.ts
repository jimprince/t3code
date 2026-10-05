const DEFAULT_LOCAL_T3_BACKEND_PORT = "3773";

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
    (first === 172 && second <= 31 && second >= 16) ||
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

export function applyPrivateRemoteDefaults(
  url: URL,
  hasExplicitProtocol: boolean,
  rawValue: string,
): void {
  // URL canonicalization erases :443 after prepending https to bare input.
  const authority = rawValue.replace(/^\/+/, "").split(/[/?#]/, 1)[0] ?? "";
  const hasExplicitPort = /:\d+$/.test(authority);
  if (
    !hasExplicitProtocol &&
    !hasExplicitPort &&
    isLocalRemoteHost(url.hostname) &&
    url.port === ""
  ) {
    url.protocol = "http:";
    url.port = DEFAULT_LOCAL_T3_BACKEND_PORT;
  }
}
