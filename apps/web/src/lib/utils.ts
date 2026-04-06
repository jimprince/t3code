import { CommandId, MessageId, ProjectId, ThreadId } from "@t3tools/contracts";
import { String, Predicate } from "effect";
import { type CxOptions, cx } from "class-variance-authority";
import { twMerge } from "tailwind-merge";
import * as Random from "effect/Random";
import * as Effect from "effect/Effect";
import { resolvePrimaryEnvironmentBootstrapUrl } from "../environmentBootstrap";

export function cn(...inputs: CxOptions) {
  return twMerge(cx(inputs));
}

export function isMacPlatform(platform: string): boolean {
  return /mac|iphone|ipad|ipod/i.test(platform);
}

export function isWindowsPlatform(platform: string): boolean {
  return /^win(dows)?/i.test(platform);
}

export function isLinuxPlatform(platform: string): boolean {
  return /linux/i.test(platform);
}

export function randomUUID(): string {
  if (typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return Effect.runSync(Random.nextUUIDv4);
}

export const newCommandId = (): CommandId => CommandId.makeUnsafe(randomUUID());

export const newProjectId = (): ProjectId => ProjectId.makeUnsafe(randomUUID());

export const newThreadId = (): ThreadId => ThreadId.makeUnsafe(randomUUID());

export const newMessageId = (): MessageId => MessageId.makeUnsafe(randomUUID());

const isNonEmptyString = Predicate.compose(Predicate.isString, String.isNonEmpty);
const firstNonEmptyString = (...values: unknown[]): string => {
  for (const value of values) {
    if (isNonEmptyString(value)) {
      return value;
    }
  }
  throw new Error("No non-empty string provided");
};

export const resolveServerUrl = (options?: {
  url?: string | undefined;
  protocol?: "http" | "https" | "ws" | "wss" | undefined;
  pathname?: string | undefined;
  searchParams?: Record<string, string> | undefined;
}): string => {
  const rawUrl = resolveBaseServerUrl(options?.url);
  const parsedUrl = resolveServerBaseUrl(rawUrl, options?.protocol);
  if (options?.protocol) {
    parsedUrl.protocol = options.protocol;
  }
  if (options?.pathname) {
    parsedUrl.pathname = options.pathname;
  } else {
    parsedUrl.pathname = "/";
  }
  if (options?.searchParams) {
    parsedUrl.search = new URLSearchParams(options.searchParams).toString();
  }
  return parsedUrl.toString();
};

export const resolveServerHttpUrl = (options?: {
  url?: string | undefined;
  pathname?: string | undefined;
  searchParams?: Record<string, string> | undefined;
}): string => {
  const rawUrl = resolveBaseServerUrl(options?.url);
  return resolveServerUrl({
    ...options,
    url: rawUrl,
    protocol: inferHttpProtocol(rawUrl),
  });
};

function resolveBaseServerUrl(url?: string | undefined): string {
  return firstNonEmptyString(
    url,
    resolvePrimaryEnvironmentBootstrapUrl(),
    import.meta.env.VITE_WS_URL,
    window.location.origin,
  );
}

function resolveServerBaseUrl(
  rawUrl: string,
  requestedProtocol: "http" | "https" | "ws" | "wss" | undefined,
): URL {
  const currentUrl = new URL(window.location.origin);
  const targetUrl = new URL(rawUrl, currentUrl);

  if (shouldUseSameOriginForLocalHttp(currentUrl, targetUrl, requestedProtocol)) {
    return new URL(currentUrl);
  }

  return targetUrl;
}

function shouldUseSameOriginForLocalHttp(
  currentUrl: URL,
  targetUrl: URL,
  requestedProtocol: "http" | "https" | "ws" | "wss" | undefined,
): boolean {
  const protocol = requestedProtocol ?? targetUrl.protocol.slice(0, -1);
  if (protocol !== "http" && protocol !== "https") {
    return false;
  }

  try {
    return (
      isLocalHostname(currentUrl.hostname) &&
      isLocalHostname(targetUrl.hostname) &&
      currentUrl.origin !== targetUrl.origin
    );
  } catch {
    return false;
  }
}

function inferHttpProtocol(rawUrl: string): "http" | "https" {
  try {
    const url = new URL(rawUrl, window.location.origin);
    if (url.protocol === "wss:" || url.protocol === "https:") {
      return "https";
    }
  } catch {
    // Fall back to http for malformed values.
  }

  return "http";
}

function isLocalHostname(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
}
