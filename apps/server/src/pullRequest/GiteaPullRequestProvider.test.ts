import { describe, expect } from "vite-plus/test";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import { ServerSettingsService } from "../serverSettings.ts";
import { SourceControlProviderRegistry } from "../sourceControl/SourceControlProviderRegistry.ts";
import { make } from "./GiteaPullRequestProvider.ts";

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const instance = {
  id: "home",
  host: "git.home",
  sshAliases: ["gitea"],
  sshPorts: [2222],
  webOrigin: "https://git.home",
  apiOrigin: "https://api.home",
  token: "secret-one",
};
const input = { cwd: "/repo", repository: "brad/repo", host: "git.home", number: 42 };
const user = { login: "brad", full_name: "Brad" };
const pr = {
  number: 42,
  title: "Feature",
  html_url: "https://git.home/brad/repo/pulls/42",
  state: "open",
  merged: false,
  user,
  body: "Description",
  head: { ref: "feature", sha: "a".repeat(40), repo: { full_name: "brad/repo" } },
  base: { ref: "main", sha: "b".repeat(40), repo: { full_name: "brad/repo" } },
  created_at: "2026-09-01T00:00:00Z",
  updated_at: "2026-09-07T00:00:00Z",
  requested_reviewers: [{ login: "reviewer" }],
  labels: [{ name: "fix", color: "ff0000" }],
  changed_files: 1,
};
function harness(respond: (url: URL) => unknown, status = 200, instances = [instance]) {
  const requests: Array<{ url: string; authorization: string | undefined; method: string }> = [];
  const run = <A, E>(f: (provider: Effect.Success<typeof make>) => Effect.Effect<A, E>) =>
    make.pipe(
      Effect.flatMap(f),
      Effect.provideService(
        HttpClient.HttpClient,
        HttpClient.make((request) => {
          requests.push({
            url: request.url,
            authorization: request.headers.authorization,
            method: request.method,
          });
          const body = respond(new URL(request.url));
          return Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              new Response(typeof body === "string" ? body : JSON.stringify(body), { status }),
            ),
          );
        }),
      ),
      Effect.provide(
        Layer.mergeAll(
          Layer.mock(SourceControlProviderRegistry)({
            resolveHandle: ({ cwd }) =>
              Effect.succeed({
                context: {
                  remoteName: "gitea",
                  remoteUrl:
                    cwd === "/other"
                      ? "ssh://git@other.home:2222/brad/repo.git"
                      : "ssh://git@gitea:2222/brad/repo.git",
                  provider: { kind: "gitea", name: "Gitea", baseUrl: instance.webOrigin },
                },
                provider: {} as never,
              }),
          }),
          ServerSettingsService.layerTest({ giteaInstances: instances }),
        ),
      ),
    );
  return { requests, run };
}
const listing = {
  ...input,
  state: "all" as const,
  involvement: "all" as const,
  viewer: "brad",
  limit: 1,
};
describe("Gitea pull request browser", () => {
  it.effect("reads the configured account rather than the first instance", () =>
    Effect.gen(function* () {
      const other = {
        ...instance,
        id: "other",
        host: "other.home",
        sshAliases: [],
        webOrigin: "https://other.home",
        apiOrigin: "https://other-api.home",
        token: "secret-two",
      };
      const h = harness(() => user, 200, [instance, other]);
      expect(yield* h.run((p) => p.getViewer({ cwd: "/other" }))).toBe("brad");
      expect(h.requests).toEqual([
        {
          url: "https://other-api.home/api/v1/user",
          authorization: "token secret-two",
          method: "GET",
        },
      ]);
    }),
  );
  it.effect("continues clamped list pages and preserves merged and deleted branch identity", () =>
    Effect.gen(function* () {
      const terminal = {
        ...pr,
        number: 41,
        state: "closed",
        merged: true,
        head: { ...pr.head, ref: "refs/pull/41/head", label: "original" },
      };
      const h = harness((url) =>
        url.searchParams.get("page") === "1"
          ? [pr]
          : url.searchParams.get("page") === "2"
            ? [terminal]
            : [],
      );
      yield* h.run((p) =>
        Effect.gen(function* () {
          const first = yield* p.listChangeRequests(listing);
          expect(first.items.map((x) => x.number)).toEqual([42]);
          expect(first.truncated).toBe(true);
          const second = yield* p.listChangeRequests({
            ...listing,
            cursor: { delivered: 1, updatedBefore: pr.updated_at },
          });
          expect(second.items[0]).toMatchObject({
            number: 41,
            state: "merged",
            headBranch: "original",
          });
          expect(second.truncated).toBe(false);
        }),
      );
    }),
  );
  it.effect("filters involvement and closed separately from merged", () =>
    Effect.gen(function* () {
      const h = harness((url) =>
        url.searchParams.get("page") === "1"
          ? [
              pr,
              { ...pr, number: 41, state: "closed", merged: true },
              { ...pr, number: 40, state: "closed" },
            ]
          : [],
      );
      yield* h.run((p) =>
        Effect.gen(function* () {
          expect(
            (yield* p.listChangeRequests({ ...listing, state: "closed", limit: 10 })).items.map(
              (x) => x.number,
            ),
          ).toEqual([40]);
          expect(
            (yield* p.listChangeRequests({
              ...listing,
              involvement: "reviewing",
              viewer: "stranger",
            })).items,
          ).toEqual([]);
        }),
      );
    }),
  );
  it.effect("no checks remains empty, never successful; mutations stay unavailable", () =>
    Effect.gen(function* () {
      const h = harness((url) =>
        url.pathname.endsWith("/status") ? { total_count: 0, state: "success", statuses: [] } : pr,
      );
      yield* h.run((p) =>
        Effect.gen(function* () {
          const detail = yield* p.getChangeRequest(input);
          expect(detail.checks).toEqual([]);
          expect(detail.checksState).toBeUndefined();
          expect(detail.viewerPermissions.actions).toEqual([]);
          expect(p.capabilities).toMatchObject({
            diff: true,
            comment: false,
            actions: [],
            review: { verdicts: [] },
          });
          expect((yield* Effect.flip(p.runAction({ ...input, action: "merge" }))).detail).toContain(
            "read-only",
          );
        }),
      );
      expect(h.requests.every((r) => r.method === "GET")).toBe(true);
    }),
  );
  it.effect("reads all CI pages, preserving pending, failure and warning outcomes", () =>
    Effect.gen(function* () {
      const h = harness((url) =>
        !url.pathname.endsWith("/status")
          ? pr
          : {
              total_count: 3,
              state: "failure",
              statuses: [
                {
                  context: "check-" + url.searchParams.get("page"),
                  status: ["pending", "error", "warning"][Number(url.searchParams.get("page")) - 1],
                },
              ],
            },
      );
      expect((yield* h.run((p) => p.getChangeRequest(input))).checks.map((c) => c.status)).toEqual([
        "pending",
        "failure",
        "action-required",
      ]);
    }),
  );
  it.effect("reads comments, submitted reviews, inline comments and commits", () =>
    Effect.gen(function* () {
      const h = harness((url) => {
        if (url.searchParams.get("page") !== null && url.searchParams.get("page") !== "1")
          return [];
        if (url.pathname.endsWith("/reviews/3/comments"))
          return [{ id: 4, user, body: "Fix this", path: "src/a.ts", created_at: pr.created_at }];
        if (url.pathname.endsWith("/comments"))
          return [{ id: 2, user, body: "Discuss", created_at: pr.created_at }];
        if (url.pathname.endsWith("/reviews"))
          return [
            {
              id: 3,
              user,
              body: "Review",
              submitted_at: pr.updated_at,
              state: "REQUEST_CHANGES",
              comments_count: 1,
            },
          ];
        if (url.pathname.endsWith("/commits"))
          return [
            {
              sha: pr.head.sha,
              commit: { message: "Fix\n\nBody", committer: { date: pr.created_at } },
            },
          ];
        return pr;
      });
      const activity = yield* h.run((p) => p.getChangeRequestActivity(input));
      expect(activity.comments.map((c) => c.kind).sort()).toEqual([
        "issue-comment",
        "review",
        "review-comment",
      ]);
      expect(activity.comments.find((c) => c.kind === "review")?.reviewState).toBe(
        "CHANGES_REQUESTED",
      );
      expect(activity.commits[0]?.messageHeadline).toBe("Fix");
      expect(activity.commentsTruncated).toBe(false);
    }),
  );
  it.effect("fetches a unified diff from the configured API", () =>
    Effect.gen(function* () {
      const patch = "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+new\n";
      const h = harness((url) => (url.pathname.endsWith(".diff") ? patch : pr));
      expect(yield* h.run((p) => p.getDiff(input))).toEqual({
        patch,
        truncated: false,
        nextCursor: null,
      });
      expect(h.requests.at(-1)?.url).toBe("https://api.home/api/v1/repos/brad/repo/pulls/42.diff");
    }),
  );
  it.effect.each([401, 403, 429, 500, 302])("redacts error responses (%s)", (status) =>
    Effect.gen(function* () {
      const h = harness(() => ({ token: "secret-one" }), status);
      const error = yield* h.run((p) => Effect.flip(p.getViewer(input)));
      expect(error.reason).toBe(
        status === 401 ? "unauthenticated" : status === 429 ? "rate-limited" : "failed",
      );
      expect(encodeJson(error)).not.toContain("secret-one");
    }),
  );
});
