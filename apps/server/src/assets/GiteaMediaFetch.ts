import type { GiteaInstanceConfig } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  HttpServerResponse,
  type HttpClientResponse,
} from "effect/http";

import { ServerSettingsService } from "../serverSettings.ts";

/**
 * Fork: thumbnails for the pictures a Gitea decision issue embeds. A private repository serves
 * its uploads only to a signed-in request, which a client never is, so the server fetches them
 * with the configured instance token. Modeled on GitHubMediaFetch, which upstream owns.
 */

/** `/attachments/<uuid>`, or the repository-scoped form Gitea also writes. */
const ATTACHMENT_PATH = /^(?:\/[^/]+\/[^/]+)?\/attachments\/[0-9a-f-]{8,}$/i;
const MAX_REDIRECTS = 3;
const MANUAL_REDIRECT: RequestInit = { redirect: "manual" };
const FORWARDED_RESPONSE_HEADERS = ["content-length", "etag", "last-modified"] as const;
/** Only pictures leave this origin; SVG stays out, since it is a document that can run script. */
const IMAGE_CONTENT_TYPE = /^image\/(?:png|jpe?g|gif|webp|avif|bmp)$/i;

const originPath = (origin: string) => new URL(origin).pathname.replace(/\/$/, "");

/**
 * Where to fetch `source` with which instance's token, or null when it is not an upload on a
 * configured Gitea instance (those are not ours to fetch with a credential). The URL is read
 * against the instance's web origin and fetched through its API origin.
 */
export function giteaMediaFetchTarget(
  source: string,
  instances: ReadonlyArray<GiteaInstanceConfig>,
): { readonly instanceId: string; readonly url: string } | null {
  let url: URL;
  try {
    url = new URL(source);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  const host = url.hostname.toLowerCase();
  const matches = instances.filter((instance) =>
    [instance.host, new URL(instance.webOrigin).hostname, new URL(instance.apiOrigin).hostname]
      .map((candidate) => candidate.toLowerCase())
      .includes(host),
  );
  if (matches.length !== 1) return null;
  const instance = matches[0]!;
  const prefix = originPath(instance.webOrigin);
  const path =
    prefix && url.pathname.startsWith(`${prefix}/`)
      ? url.pathname.slice(prefix.length)
      : url.pathname;
  if (!ATTACHMENT_PATH.test(path)) return null;
  return {
    instanceId: instance.id,
    url: `${new URL(instance.apiOrigin).origin}${originPath(instance.apiOrigin)}${path}`,
  };
}

/** Follows Gitea's redirect to object storage without carrying the token off the instance. */
const fetchFollowingRedirects = Effect.fn("GiteaMediaFetch.fetchFollowingRedirects")(function* (
  url: string,
  instance: GiteaInstanceConfig,
) {
  const httpClient = HttpClient.withScope(yield* HttpClient.HttpClient);
  const credentialOrigin = new URL(instance.apiOrigin).origin;
  let target = url;
  for (let hop = 0; ; hop += 1) {
    const authorization =
      instance.token && new URL(target).origin === credentialOrigin
        ? `token ${instance.token}`
        : null;
    const response: HttpClientResponse.HttpClientResponse = yield* httpClient
      .execute(
        HttpClientRequest.get(target).pipe(
          HttpClientRequest.setHeaders({
            "accept-encoding": "identity",
            ...(authorization === null ? {} : { authorization }),
          }),
        ),
      )
      .pipe(Effect.provideService(FetchHttpClient.RequestInit, MANUAL_REDIRECT));
    const location = response.headers.location;
    if (response.status < 300 || response.status >= 400) return response;
    if (!location || hop >= MAX_REDIRECTS) return null;
    const next = new URL(location, target);
    if (next.protocol !== "https:" && next.protocol !== "http:") return null;
    target = next.toString();
  }
});

/** Serves one Gitea upload through the instance token, as an image or not at all. */
export const giteaMediaResponse = Effect.fn("GiteaMediaFetch.giteaMediaResponse")(
  function* (asset: {
    readonly url: string;
    readonly instanceId: string;
    readonly expiresAt: number;
  }) {
    const remainingSeconds = Math.floor(
      (asset.expiresAt - (yield* Clock.currentTimeMillis)) / 1000,
    );
    const headers: Record<string, string> = {
      "cache-control":
        remainingSeconds > 0 ? `private, max-age=${remainingSeconds}` : "private, no-store",
      "x-content-type-options": "nosniff",
    };
    const settings = yield* (yield* ServerSettingsService).getSettings;
    // The instance is looked up again rather than signed into the URL, so the token never is.
    const instance = settings.giteaInstances.find((candidate) => candidate.id === asset.instanceId);
    if (!instance) return HttpServerResponse.empty({ status: 404, headers });
    const response = yield* fetchFollowingRedirects(asset.url, instance);
    if (response === null) return HttpServerResponse.empty({ status: 502, headers });
    if (response.status >= 400) {
      return HttpServerResponse.empty({
        status: response.status >= 500 ? 502 : response.status,
        headers,
      });
    }
    const contentType =
      response.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
    if (!IMAGE_CONTENT_TYPE.test(contentType)) {
      return HttpServerResponse.empty({ status: 415, headers });
    }
    for (const name of FORWARDED_RESPONSE_HEADERS) {
      const value = response.headers[name];
      if (value !== undefined) headers[name] = value;
    }
    headers["content-type"] = contentType;
    return HttpServerResponse.stream(response.stream, {
      status: response.status,
      headers,
      contentType,
    });
  },
);
