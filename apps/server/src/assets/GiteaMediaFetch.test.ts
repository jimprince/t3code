import { it } from "@effect/vitest";
import type { GiteaInstanceConfig } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import { describe, expect } from "vite-plus/test";

import { ServerSettingsService } from "../serverSettings.ts";
import { giteaMediaFetchTarget, giteaMediaResponse } from "./GiteaMediaFetch.ts";

const instance: GiteaInstanceConfig = {
  id: "home",
  host: "git.home",
  sshAliases: [],
  sshPorts: [2222],
  webOrigin: "https://git.bradleyprince.com",
  apiOrigin: "http://git.home:3000",
  token: "secret-token",
};

describe("giteaMediaFetchTarget", () => {
  it("fetches an instance's uploads through its API origin, whichever alias the body used", () => {
    expect(
      giteaMediaFetchTarget("https://git.bradleyprince.com/attachments/1b2c3d4e-0000", [instance]),
    ).toEqual({ instanceId: "home", url: "http://git.home:3000/attachments/1b2c3d4e-0000" });
    expect(
      giteaMediaFetchTarget("http://git.home:3000/brad/robot/attachments/9f8e7d6c-1111", [
        instance,
      ]),
    ).toEqual({
      instanceId: "home",
      url: "http://git.home:3000/brad/robot/attachments/9f8e7d6c-1111",
    });
  });

  it("refuses anything that is not an upload on a configured instance", () => {
    expect(
      giteaMediaFetchTarget("https://evil.example/attachments/1b2c3d4e-0000", [instance]),
    ).toBe(null);
    expect(
      giteaMediaFetchTarget("https://git.bradleyprince.com/brad/robot/raw/main/a.png", [instance]),
    ).toBe(null);
    expect(giteaMediaFetchTarget("file:///etc/passwd", [instance])).toBe(null);
  });
});

describe("giteaMediaResponse", () => {
  const serve = (
    contentType: string,
    seen: Array<{ url: string; authorization: string | undefined }>,
  ) =>
    giteaMediaResponse({
      url: "http://git.home:3000/attachments/1b2c3d4e-0000",
      instanceId: "home",
      // Far enough out that the response is cacheable whatever the test clock reads.
      expiresAt: Number.MAX_SAFE_INTEGER,
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          ServerSettingsService.layerTest({ giteaInstances: [instance] }),
          Layer.succeed(
            HttpClient.HttpClient,
            HttpClient.make((request) => {
              seen.push({ url: request.url, authorization: request.headers.authorization });
              // Gitea hands large uploads to object storage with a redirect.
              if (request.url.startsWith("http://git.home:3000/")) {
                return Effect.succeed(
                  HttpClientResponse.fromWeb(
                    request,
                    new Response(null, {
                      status: 302,
                      headers: { location: "https://store.example/signed/abc" },
                    }),
                  ),
                );
              }
              return Effect.succeed(
                HttpClientResponse.fromWeb(
                  request,
                  new Response("bytes", { headers: { "content-type": contentType } }),
                ),
              );
            }),
          ),
        ),
      ),
    );

  it.effect("sends the token to the instance only and serves the image", () =>
    Effect.gen(function* () {
      const seen: Array<{ url: string; authorization: string | undefined }> = [];
      const response = yield* serve("image/png", seen);
      expect(response.status).toBe(200);
      expect(response.headers["content-type"]).toBe("image/png");
      expect(seen).toEqual([
        {
          url: "http://git.home:3000/attachments/1b2c3d4e-0000",
          authorization: "token secret-token",
        },
        { url: "https://store.example/signed/abc", authorization: undefined },
      ]);
    }),
  );

  it.effect("refuses to serve an upload that is not a picture", () =>
    Effect.gen(function* () {
      const response = yield* serve("text/html", []);
      expect(response.status).toBe(415);
    }),
  );
});
