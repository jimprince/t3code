import * as TestClock from "effect/testing/TestClock";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Layer from "effect/Layer";
import { ServerConfig } from "../config.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import { describe, expect } from "vite-plus/test";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import { ServerSettingsService } from "../serverSettings.ts";
import { make } from "./GiteaSourceControlProvider.ts";

const runtimeLayer = GitVcsDriver.layer.pipe(
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-gitea-test-" })),
  Layer.provideMerge(VcsProcess.layer),
  Layer.provideMerge(NodeServices.layer),
);
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const instance = {
  id: "home",
  host: "git.home",
  sshAliases: ["home-git"],
  sshPorts: [2222],
  webOrigin: "http://git.home:3000",
  apiOrigin: "http://api.home:3000",
  token: "test-secret",
};
const context = {
  provider: { kind: "gitea" as const, name: "Gitea", baseUrl: instance.webOrigin },
  remoteName: "origin",
  remoteUrl: "ssh://git@git.home:2222/brad/repo.git",
};
const pr = {
  number: 42,
  title: "Feature",
  html_url: "http://git.home:3000/brad/repo/pulls/42",
  state: "open",
  merged: false,
  updated_at: "2026-09-04T12:00:00Z",
  head: { ref: "feature/slash", repo: { id: 1, full_name: "brad/repo" } },
  base: { ref: "main", repo: { id: 1, full_name: "brad/repo" } },
};
function harness(
  pages: ReadonlyArray<unknown>,
  status = 200,
  instances = [instance],
  tip?: () => string,
) {
  const requests: Array<{
    url: string;
    authorization: string | undefined;
    method: string;
    body: unknown;
  }> = [];
  const run = <A, E>(f: (value: Effect.Success<typeof make>) => Effect.Effect<A, E>) =>
    make.pipe(
      Effect.flatMap(f),
      Effect.provideService(
        HttpClient.HttpClient,
        HttpClient.make((request) => {
          requests.push({
            url: request.url,
            authorization: request.headers.authorization,
            method: request.method,
            body: request.body,
          });
          return Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              new Response(encodeJson(pages[requests.length - 1] ?? []), { status }),
            ),
          );
        }),
      ),
      Effect.provide(
        Layer.mergeAll(
          ServerSettingsService.layerTest({ giteaInstances: instances }),
          runtimeLayer,
          tip
            ? Layer.mock(VcsProcess.VcsProcess)({
                run: () =>
                  Effect.succeed({
                    stdout: tip(),
                    stderr: "",
                    exitCode: 0 as never,
                    stdoutTruncated: false,
                    stderrTruncated: false,
                  }),
              })
            : Layer.empty,
        ),
      ),
    );
  return { requests, run };
}
const input = { cwd: "/repo", context, headSelector: "feature/slash", state: "all" as const };
describe("Gitea absent branch lookup", () => {
  it.effect("reuses a complete absent-branch scan until the tip changes or its TTL expires", () =>
    Effect.gen(function* () {
      let tip = "a".repeat(40);
      const h = harness(
        [[{ ...pr, head: { ...pr.head, ref: "other" } }], [], [], [pr], []],
        200,
        [instance],
        () => tip,
      );
      yield* h.run(({ provider }) =>
        Effect.gen(function* () {
          expect(yield* provider.listChangeRequests(input)).toEqual([]);
          expect(h.requests).toHaveLength(2);
          expect(yield* provider.listChangeRequests(input)).toEqual([]);
          expect(h.requests).toHaveLength(2);
          tip = "b".repeat(40);
          expect(yield* provider.listChangeRequests(input)).toEqual([]);
          expect(h.requests).toHaveLength(3);
          yield* TestClock.adjust("5 minutes");
          expect((yield* provider.listChangeRequests(input)).map((p) => p.number)).toEqual([42]);
          expect(h.requests).toHaveLength(5);
        }),
      );
    }),
  );
  it.effect("does not cache failed scans or hide a valid match on a later page", () =>
    Effect.gen(function* () {
      const pages = Array.from({ length: 25 }, () => [
        { ...pr, head: { ...pr.head, ref: "other" } },
      ]);
      const h = harness([...pages, [pr], []], 200, [instance], () => "a".repeat(40));
      expect(
        (yield* h.run(({ provider }) => provider.listChangeRequests(input))).map((p) => p.number),
      ).toEqual([42]);
      expect(h.requests).toHaveLength(27);
      const failed = harness([], 500, [instance], () => "a".repeat(40));
      yield* failed.run(({ provider }) =>
        Effect.gen(function* () {
          yield* Effect.flip(provider.listChangeRequests(input));
          yield* Effect.flip(provider.listChangeRequests(input));
        }),
      );
      expect(failed.requests).toHaveLength(2);
    }),
  );
});
