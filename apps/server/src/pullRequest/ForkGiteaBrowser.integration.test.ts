import * as NodeServices from "@effect/platform-node/NodeServices";
import * as KeyValueStore from "effect/unstable/persistence/KeyValueStore";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { ChildProcessSpawner } from "effect/unstable/process";
import type { OrchestrationProjectShell } from "@t3tools/contracts";
import { ProjectId } from "@t3tools/contracts";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import * as ServerSettings from "../serverSettings.ts";
import * as ProjectService from "../project/ProjectService.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as PullRequestFilesViewed from "../persistence/PullRequestFilesViewed.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import * as SourceControlProviderRegistry from "../sourceControl/SourceControlProviderRegistry.ts";
import * as SourceControlRateLimit from "../sourceControl/SourceControlRateLimit.ts";
import * as ForgejoCli from "../sourceControl/ForgejoCli.ts";
import * as ForgejoPullRequestProvider from "./ForgejoPullRequestProvider.ts";
import * as GiteaPullRequestProvider from "./GiteaPullRequestProvider.ts";
import type { PullRequestProviderApi } from "./PullRequestProvider.ts";
import * as PullRequestProviderRegistry from "./PullRequestProviderRegistry.ts";
import * as PullRequestService from "./PullRequestService.ts";
import * as PullRequestReadCache from "./PullRequestReadCache.ts";

function makeService(input: {
  readonly projects: ReadonlyArray<OrchestrationProjectShell>;
  readonly providers: ReadonlyArray<PullRequestProviderApi>;
  readonly resolveHandle?: SourceControlProviderRegistry.SourceControlProviderRegistry["Service"]["resolveHandle"];
  readonly resolveRepositoryIdentity?: RepositoryIdentityResolver.RepositoryIdentityResolver["Service"]["resolve"];
}) {
  // Built into the test's own scope rather than provided call by call: the marks store owns a
  // database, and `Effect.provide` would close it the moment the service was handed back.
  return Effect.flatMap(
    Layer.build(
      Layer.mergeAll(
        Layer.succeed(
          PullRequestProviderRegistry.PullRequestProviderRegistry,
          PullRequestProviderRegistry.fromProviders(input.providers),
        ),
        Layer.mock(SourceControlProviderRegistry.SourceControlProviderRegistry)({
          resolveLink: () => undefined,
          resolveHandle:
            input.resolveHandle ?? (() => Effect.die("Unexpected provider refinement")),
        }),
        Layer.mock(ProjectService.ProjectService)({
          listShells: (options) =>
            Effect.succeed(
              input.projects.filter((project) => options?.projectIds?.includes(project.id) ?? true),
            ),
          getShell: (projectId) =>
            Effect.succeed(Option.fromNullishOr(input.projects.find((p) => p.id === projectId))),
        }),
        Layer.mock(RepositoryIdentityResolver.RepositoryIdentityResolver)({
          resolve: input.resolveRepositoryIdentity ?? (() => Effect.succeed(null)),
        }),
        SourceControlRateLimit.layer,
        // The real store over a database of its own, so the environment-kept marks are exercised
        // through the SQL that holds them rather than through a stand-in that agrees with itself.
        PullRequestFilesViewed.layer.pipe(Layer.provide(SqlitePersistenceMemory)),
        Layer.effect(PullRequestReadCache.PullRequestReadCache, PullRequestReadCache.make).pipe(
          Layer.provide(KeyValueStore.layerMemory),
          Layer.provide(NodeServices.layer),
        ),
      ),
    ),
    (context) => Effect.provideContext(PullRequestService.make, context),
  );
}

const instance = {
  id: "configured",
  host: "git.example.test",
  sshAliases: [],
  sshPorts: [22],
  webOrigin: "https://git.example.test",
  apiOrigin: "https://api.example.test",
  token: "secret",
};
const pull = {
  number: 42,
  title: "Feature",
  html_url: "https://wrong.example/brad/repo/pull/42",
  state: "open",
  merged: false,
  user: { login: "brad", full_name: "Brad" },
  body: "Description",
  head: { ref: "feature", sha: "a".repeat(40), repo: { full_name: "brad/repo" } },
  base: { ref: "main", sha: "b".repeat(40), repo: { full_name: "brad/repo" } },
  closed_at: null,
  merged_at: null,
  created_at: "2026-10-01T00:00:00Z",
  updated_at: "2026-10-05T00:00:00Z",
  requested_reviewers: [],
  labels: [],
  changed_files: 1,
};
const patch =
  "diff --git a/code.ts b/code.ts\nindex 1111111..2222222 100644\n--- a/code.ts\n+++ b/code.ts\n@@ -1 +1 @@\n-old\n+new\n";
function project(id: string, provider: string, host: string): OrchestrationProjectShell {
  return {
    id: ProjectId.make(id),
    title: id,
    workspaceRoot: `/${id}`,
    repositoryIdentity: {
      canonicalKey: `${host}/brad/repo`,
      displayName: "brad/repo",
      provider,
      locator: {
        source: "git-remote",
        remoteName: "origin",
        remoteUrl: `https://${host}/brad/repo.git`,
      },
    },
    defaultModelSelection: null,
    scripts: [],
    createdAt: "2026-10-01T00:00:00Z",
    updatedAt: "2026-10-01T00:00:00Z",
  };
}
it.effect(
  "routes configured HTTP and native Forgejo separately and persists viewed-file marks",
  () =>
    Effect.gen(function* () {
      let httpCalls = 0;
      let cliCalls = 0;
      const resolveHandle: SourceControlProviderRegistry.SourceControlProviderRegistry["Service"]["resolveHandle"] =
        ({ cwd }) =>
          Effect.succeed({
            provider: undefined as never,
            context: {
              provider: {
                kind: cwd === "/configured" ? "gitea" : "forgejo",
                name: "host",
                baseUrl: cwd === "/configured" ? instance.webOrigin : "https://codeberg.org",
              },
              remoteName: "origin",
              remoteUrl:
                cwd === "/configured"
                  ? "https://git.example.test/brad/repo.git"
                  : "https://codeberg.org/brad/repo.git",
            },
          });
      const gitea = yield* GiteaPullRequestProvider.make.pipe(
        Effect.provide(
          Layer.mergeAll(
            ServerSettings.layerTest({ giteaInstances: [instance] }),
            Layer.mock(SourceControlProviderRegistry.SourceControlProviderRegistry)({
              resolveLink: () => undefined,
              resolveHandle,
            }),
          ),
        ),
        Effect.provideService(
          HttpClient.HttpClient,
          HttpClient.make((request) => {
            httpCalls++;
            assert.equal(request.headers.authorization, "token secret");
            const body = request.url.endsWith(".diff")
              ? patch
              : JSON.stringify(request.url.endsWith("/user") ? { login: "brad" } : pull);
            return Effect.succeed(HttpClientResponse.fromWeb(request, new Response(body)));
          }),
        ),
      );
      const forgejo = yield* ForgejoPullRequestProvider.make.pipe(
        Effect.provide(
          Layer.mock(ForgejoCli.ForgejoCli)({
            api: () => {
              cliCalls++;
              return Effect.succeed({
                stdout: JSON.stringify({
                  ...pull,
                  html_url: "https://codeberg.org/brad/repo/pulls/42",
                }),
                stderr: "",
                exitCode: ChildProcessSpawner.ExitCode(0),
                stdoutTruncated: false,
                stderrTruncated: false,
              });
            },
          }),
        ),
      );
      const service = yield* makeService({
        projects: [
          project("configured", "gitea", "git.example.test"),
          project("native", "forgejo", "codeberg.org"),
        ],
        providers: [gitea, forgejo],
        resolveHandle,
      });
      const ref = { projectId: ProjectId.make("configured"), repository: "brad/repo", number: 42 };
      const summary = yield* service.summary(ref);
      assert.equal(summary.provider, "gitea");
      assert.equal(summary.url, "https://git.example.test/brad/repo/pulls/42");
      const beforeNative = httpCalls;
      assert.equal(
        (yield* service.summary({ ...ref, projectId: ProjectId.make("native") })).provider,
        "forgejo",
      );
      assert.equal(httpCalls, beforeNative);
      assert.equal(cliCalls, 1);
      yield* service.setFilesViewed({ ...ref, files: [{ path: "code.ts", viewed: true }] });
      const viewed = yield* service.filesViewed(ref);
      assert.deepEqual(
        viewed.files.map((file) => file.path),
        ["code.ts"],
      );
      yield* service.setFilesViewed({ ...ref, files: [{ path: "code.ts", viewed: false }] });
      assert.deepEqual((yield* service.filesViewed(ref)).files, []);
    }),
);
