import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Layer from "effect/Layer";
import * as FileSystem from "effect/FileSystem";
import { ServerConfig } from "../config.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import { describe, expect } from "vite-plus/test";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { FetchHttpClient, HttpClient, HttpClientResponse } from "effect/unstable/http";
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
function harness(pages: ReadonlyArray<unknown>, status = 200, instances = [instance]) {
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
        ),
      ),
    );
  return { requests, run };
}
const input = { cwd: "/repo", context, headSelector: "feature/slash", state: "all" as const };
describe("Gitea branch pull requests", () => {
  it.effect.each([false, true])("retains deleted-head PR identity (merged=%s)", (merged) =>
    Effect.gen(function* () {
      const deleted = {
        ...pr,
        state: "closed",
        merged,
        head: { ...pr.head, ref: "refs/pull/42/head", label: "feature/slash" },
      };
      const h = harness([
        [
          { ...deleted, head: { ...deleted.head, repo: { id: 2, full_name: "brad/other" } } },
          deleted,
        ],
        [],
      ]);
      const results = yield* h.run(({ provider }) => provider.listChangeRequests(input));
      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({
        number: 42,
        headRefName: "feature/slash",
        state: merged ? "merged" : "closed",
        isCrossRepository: false,
      });
    }),
  );

  it.effect("does not use labels to override ordinary or invalid head references", () =>
    Effect.gen(function* () {
      const h = harness([
        [
          { ...pr, state: "closed", head: { ...pr.head, ref: "other", label: "feature/slash" } },
          { ...pr, head: { ...pr.head, ref: "refs/pull/42/head", label: "feature/slash" } },
          {
            ...pr,
            state: "closed",
            head: { ...pr.head, ref: "refs/pull/99/head", label: "feature/slash" },
          },
          { ...pr, state: "closed", head: { ...pr.head, ref: "refs/pull/42/head", label: null } },
        ],
        [],
      ]);
      expect(yield* h.run(({ provider }) => provider.listChangeRequests(input))).toEqual([]);
    }),
  );

  it.effect("disables redirect following in the actual fetch transport", () =>
    Effect.gen(function* () {
      let calls = 0;
      const error = yield* make.pipe(
        Effect.flatMap(({ provider }) => Effect.flip(provider.listChangeRequests(input))),
        Effect.provide(FetchHttpClient.layer),
        Effect.provideService(
          FetchHttpClient.Fetch,
          Object.assign(
            async (...[_url, init]: Parameters<typeof globalThis.fetch>) => {
              calls++;
              expect(init?.redirect).toBe("manual");
              return new Response(null, {
                status: 302,
                headers: { location: "https://other.example/" },
              });
            },
            { preconnect: () => undefined },
          ),
        ),
        Effect.provide(
          Layer.mergeAll(
            ServerSettingsService.layerTest({ giteaInstances: [instance] }),
            runtimeLayer,
          ),
        ),
      );
      expect(error.detail).toBe("Gitea API returned HTTP 302.");
      expect(calls).toBe(1);
    }),
  );

  it.effect("keeps two instances and their credentials separate", () =>
    Effect.gen(function* () {
      const second = {
        ...instance,
        id: "work",
        host: "git.work",
        sshAliases: [],
        apiOrigin: "https://api.work",
        webOrigin: "https://git.work",
        token: "work-secret",
      };
      const h = harness([[pr]], 200, [instance, second]);
      yield* h.run(({ provider }) =>
        provider.listChangeRequests({
          ...input,
          limit: 1,
          context: { ...context, remoteUrl: "ssh://git@git.work:2222/brad/repo.git" },
        }),
      );
      expect(h.requests[0]).toMatchObject({
        url: "https://api.work/api/v1/repos/brad/repo/pulls?state=all&sort=recentupdate&page=1&limit=50",
        authorization: "token work-secret",
      });
    }),
  );
  it.effect("rejects malformed API responses without exposing the body", () =>
    Effect.gen(function* () {
      const h = harness([{ token: "test-secret" }]);
      const error = yield* h.run(({ provider }) => Effect.flip(provider.listChangeRequests(input)));
      expect(error.detail).toBe("Invalid Gitea API response.");
      expect(encodeJson(error)).not.toContain("test-secret");
    }),
  );

  it.effect(
    "paginates before limiting, excludes fork collisions, and preserves URL and timestamp",
    () =>
      Effect.gen(function* () {
        const h = harness([
          [{ ...pr, head: { ...pr.head, repo: { id: 2, full_name: "other/repo" } } }],
          [pr],
        ]);
        const results = yield* h.run(({ provider }) =>
          provider.listChangeRequests({ ...input, limit: 1 }),
        );
        expect(results).toHaveLength(1);
        expect(results[0]).toMatchObject({
          provider: "gitea",
          number: 42,
          url: pr.html_url,
          state: "open",
          headRefName: "feature/slash",
          isCrossRepository: false,
        });
        expect(Option.map(results[0]!.updatedAt, DateTime.formatIso)).toEqual(
          Option.some("2026-09-04T12:00:00.000Z"),
        );
        expect(h.requests).toMatchObject(
          [1, 2].map((page) => ({
            url: `http://api.home:3000/api/v1/repos/brad/repo/pulls?state=all&sort=recentupdate&page=${page}&limit=50`,
            authorization: "token test-secret",
          })),
        );
      }),
  );
  it.effect("matches structured fork identity even when the owner has multiple forks", () =>
    Effect.gen(function* () {
      const fork = { ...pr, head: { ...pr.head, repo: { id: 3, full_name: "other/renamed" } } };
      const h = harness([
        [pr, { ...fork, head: { ...fork.head, repo: { id: 2, full_name: "other/repo" } } }, fork],
        [],
      ]);
      const results = yield* h.run(({ provider }) =>
        provider.listChangeRequests({
          ...input,
          source: { refName: "feature/slash", repository: "other/renamed" },
        }),
      );
      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({
        isCrossRepository: true,
        headRepositoryNameWithOwner: "other/renamed",
      });
    }),
  );
  it.effect.each(["closed", "merged"] as const)("distinguishes %s state", (state) =>
    Effect.gen(function* () {
      const h = harness([
        [
          { ...pr, state: "closed", merged: false },
          { ...pr, number: 43, state: "closed", merged: true },
        ],
        [],
      ]);
      const results = yield* h.run(({ provider }) =>
        provider.listChangeRequests({ ...input, state }),
      );
      expect(results.map((value) => value.state)).toEqual([state]);
    }),
  );
  it.effect(
    "returns empty results for other branches, deleted heads and mismatched target repositories",
    () =>
      Effect.gen(function* () {
        const h = harness([
          [
            { ...pr, head: { ...pr.head, ref: "feature/other" } },
            { ...pr, head: { ...pr.head, repo: null } },
            { ...pr, base: { ...pr.base, repo: { id: 8, full_name: "another/repo" } } },
          ],
          [],
        ]);
        expect(yield* h.run(({ provider }) => provider.listChangeRequests(input))).toEqual([]);
      }),
  );
  it.effect("returns an empty list when no PR exists", () =>
    Effect.gen(function* () {
      const h = harness([[]]);
      expect(yield* h.run(({ provider }) => provider.listChangeRequests(input))).toEqual([]);
      expect(h.requests).toHaveLength(1);
    }),
  );
  it.effect.each([401, 403, 500, 302])(
    "reports HTTP %s without exposing credentials or response bodies",
    (status) =>
      Effect.gen(function* () {
        const h = harness([{ message: "test-secret" }], status);
        const error = yield* h.run(({ provider }) =>
          Effect.flip(provider.listChangeRequests(input)),
        );
        expect(error.detail).toBe(`Gitea API returned HTTP ${status}.`);
        expect(encodeJson(error)).not.toContain("test-secret");
        expect(h.requests).toHaveLength(1);
      }),
  );
  it.effect("probes authentication via /user", () =>
    Effect.gen(function* () {
      const h = harness([{ login: "brad" }]);
      expect(yield* h.run(({ discovery }) => discovery.probeAuth)).toMatchObject({
        status: "authenticated",
      });
      expect(h.requests[0]?.url).toBe("http://api.home:3000/api/v1/user");
    }),
  );
});

describe("Gitea pull request actions", () => {
  it.effect.each(["42", "#42", pr.html_url])("resolves %s with fork identity", (reference) =>
    Effect.gen(function* () {
      const h = harness([
        { ...pr, head: { ...pr.head, repo: { id: 2, full_name: "alice/fork" } } },
      ]);
      expect(
        yield* h.run(({ provider }) =>
          provider.getChangeRequest({ cwd: "/repo", context, reference }),
        ),
      ).toMatchObject({
        number: 42,
        url: pr.html_url,
        headRefName: "feature/slash",
        isCrossRepository: true,
        headRepositoryNameWithOwner: "alice/fork",
      });
      expect(h.requests[0]?.url).toBe("http://api.home:3000/api/v1/repos/brad/repo/pulls/42");
    }),
  );

  it.effect.each([
    "http://evil.home:3000/brad/repo/pulls/42",
    "http://git.home:3000/brad/other/pulls/42",
  ])("rejects a URL outside the selected repository: %s", (reference) =>
    Effect.gen(function* () {
      const h = harness([pr]);
      yield* h.run(({ provider }) =>
        Effect.flip(provider.getChangeRequest({ cwd: "/repo", context, reference })),
      );
      expect(h.requests).toHaveLength(0);
    }),
  );

  it.effect("creates a PR with the requested body, fork and target branch", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-gitea-body-" });
        const bodyFile = `${dir}/body.md`;
        yield* fs.writeFileString(bodyFile, "Description\n\n- exact body");
        const h = harness([pr], 201);
        yield* h.run(({ provider }) =>
          provider.createChangeRequest({
            cwd: dir,
            context,
            title: "Feature",
            bodyFile,
            source: { refName: "feature/slash", repository: "alice/renamed-fork" },
            headSelector: "feature/slash",
            baseRefName: "main",
          }),
        );
        const sent = h.requests[0];
        expect(sent?.method).toBe("POST");
        expect(sent?.url).toBe("http://api.home:3000/api/v1/repos/brad/repo/pulls");
        expect(sent?.body).toMatchObject({ _tag: "Uint8Array" });
        const body = sent?.body as { body: Uint8Array };
        expect(
          yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown))(
            new TextDecoder().decode(body.body),
          ),
        ).toEqual({
          title: "Feature",
          body: "Description\n\n- exact body",
          head: "alice/renamed-fork:feature/slash",
          base: "main",
        });
      }),
    ).pipe(Effect.provide(runtimeLayer)),
  );

  it.effect("checks out a retained PR ref after its source branch was deleted", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const git = yield* GitVcsDriver.GitVcsDriver;
        const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "t3-gitea-checkout-" });
        const run = (args: ReadonlyArray<string>) => git.execute({ cwd, operation: "test", args });
        yield* run(["init", "--initial-branch=main"]);
        yield* run(["config", "user.name", "Test"]);
        yield* run(["config", "user.email", "test@example.com"]);
        yield* run(["commit", "--allow-empty", "-m", "base"]);
        yield* run(["checkout", "-b", "feature/slash"]);
        yield* fs.writeFileString(`${cwd}/feature.txt`, "pull request content");
        yield* run(["add", "feature.txt"]);
        yield* run(["commit", "-m", "feature"]);
        yield* run(["update-ref", "refs/pull/42/head", "HEAD"]);
        yield* run(["checkout", "main"]);
        yield* run(["branch", "-D", "feature/slash"]);
        yield* run(["config", `url.${cwd}.insteadOf`, context.remoteUrl]);
        const h = harness([
          {
            ...pr,
            state: "closed",
            merged: true,
            head: { ...pr.head, ref: "refs/pull/42/head", label: "feature/slash" },
          },
        ]);
        yield* h.run(({ provider }) =>
          provider.checkoutChangeRequest({ cwd, context, reference: "42", force: true }),
        );
        expect(yield* fs.readFileString(`${cwd}/feature.txt`)).toBe("pull request content");
        expect((yield* run(["branch", "--show-current"])).stdout.trim()).toBe("feature/slash");
      }),
    ).pipe(Effect.provide(runtimeLayer)),
  );
});
