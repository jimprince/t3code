import { giteaPullRequestUrl } from "../sourceControl/giteaSettings.ts";
import { parseDiffFileRevisions } from "./bitbucketDiffRevisions.ts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type {
  GiteaInstanceConfig,
  PullRequestCapabilities,
  PullRequestComment,
  PullRequestViewerPermissions,
} from "@t3tools/contracts";
import {
  detectSourceControlProviderFromRemoteUrl,
  resolveGiteaRemote,
} from "@t3tools/shared/sourceControl";
import { ServerSettingsService } from "../serverSettings.ts";
import { SourceControlProviderRegistry } from "../sourceControl/SourceControlProviderRegistry.ts";
import * as GiteaApi from "../sourceControl/GiteaApi.ts";
import * as Json from "./giteaPullRequestJson.ts";
import {
  PullRequestProviderError,
  type PullRequestProviderApi,
  type ProviderRepositoryRef,
} from "./PullRequestProvider.ts";

const capabilities: PullRequestCapabilities = {
  diff: true,
  viewedFiles: "environment",
  comment: false,
  actions: [],
  mergeMethods: [],
  search: false,
  reactions: false,
  review: { inlineComment: false, reply: false, resolve: false, verdicts: [] },
  reviewers: { request: false, listCandidates: false },
  edit: { changeRequest: false, comment: false },
  labels: false,
};
const permissions: PullRequestViewerPermissions = {
  actions: [],
  comment: false,
  resolve: false,
  verdicts: [],
  requestReviewers: false,
  labels: false,
};
const fail = (operation: string, detail: string, status?: number) =>
  new PullRequestProviderError({
    provider: "gitea",
    operation,
    detail,
    reason: status === 401 ? "unauthenticated" : status === 429 ? "rate-limited" : "failed",
  });

const RepositoryName = Schema.Struct({ full_name: Schema.String });
// A miss says nothing lasting about a host (the repository may simply not exist yet), so it
// is only remembered for a while rather than learned.
const ALIAS_MISS_TTL_MS = 10 * 60 * 1000;
// Hosts of other forges are never an address of a Gitea instance, whatever repositories it holds.
const FOREIGN_FORGES = new Set(["github", "gitlab", "azure-devops", "bitbucket"]);

const validRepository = (repository: string) => /^[^/\s]+\/[^/\s]+$/.test(repository);
const hostOfUrl = (url: string) => {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return null;
  }
};
const instanceNames = (instance: GiteaInstanceConfig) =>
  [instance.host, hostOfUrl(instance.webOrigin), ...instance.sshAliases].flatMap((name) =>
    name === null ? [] : [name.toLowerCase()],
  );

export const make = Effect.gen(function* () {
  const settings = yield* ServerSettingsService;
  const registry = yield* SourceControlProviderRegistry;
  const api = yield* GiteaApi.make;
  // Public hosts a proxy serves an instance on, learned when the instance serves the repository
  // a link names on that host. Gitea builds its URLs from the request, so it cannot report them.
  const learnedHosts = new Map<string, string>();
  const aliasMisses = new Map<string, number>();
  const resolve = Effect.fn("GiteaPullRequest.resolve")(function* (input: {
    cwd: string;
    repository?: string;
    host?: string;
  }) {
    const config = yield* settings.getSettings.pipe(
      Effect.mapError(() => fail("resolve", "Could not read Gitea settings.")),
    );
    const handle = yield* registry
      .resolveHandle(input)
      .pipe(Effect.option, Effect.map(Option.getOrUndefined));
    const remote =
      handle?.context && resolveGiteaRemote(handle.context.remoteUrl, config.giteaInstances);
    if (
      remote &&
      (input.repository === undefined ||
        remote.repository.toLowerCase() === input.repository.toLowerCase())
    )
      return remote;
    // A reference to another repository on a configured instance needs no checkout of it.
    const host = input.host?.toLowerCase();
    const named =
      host === undefined || input.repository === undefined
        ? []
        : config.giteaInstances.filter(
            (instance) =>
              instanceNames(instance).includes(host) || learnedHosts.get(host) === instance.id,
          );
    if (named.length === 1 && input.repository !== undefined && validRepository(input.repository))
      return { instance: named[0]!, repository: input.repository };
    if (input.repository !== undefined && !validRepository(input.repository))
      return yield* fail("resolve", "Invalid Gitea target repository.");
    if (remote)
      return input.repository === undefined ? remote : { ...remote, repository: input.repository };
    return yield* fail(
      "resolve",
      "No unambiguous configured Gitea instance matches this repository.",
    );
  });
  const resolveHostAlias = Effect.fn("GiteaPullRequest.resolveHostAlias")(function* (input: {
    host: string;
    repository: string;
  }) {
    const host = input.host.trim().toLowerCase();
    const config = yield* settings.getSettings.pipe(
      Effect.mapError(() => fail("resolve", "Could not read Gitea settings.")),
    );
    const matches = config.giteaInstances.filter(
      (instance) =>
        instanceNames(instance).includes(host) || learnedHosts.get(host) === instance.id,
    );
    if (matches.length > 0) return matches.length === 1 ? matches[0]!.host.toLowerCase() : null;
    if (
      FOREIGN_FORGES.has(detectSourceControlProviderFromRemoteUrl(`https://${host}/`)?.kind ?? "")
    )
      return null;
    const key = `${host}|${input.repository.toLowerCase()}`;
    const now = yield* Clock.currentTimeMillis;
    if ((aliasMisses.get(key) ?? 0) > now) return null;
    // The host proves nothing, so the instances are candidates and the one that serves the
    // repository is the answer; two serving it leave the host ambiguous.
    const serving = yield* Effect.filter(
      config.giteaInstances,
      (instance) =>
        api.request(instance, GiteaApi.repositoryPath(input.repository), RepositoryName).pipe(
          Effect.map((found) => found.full_name.toLowerCase() === input.repository.toLowerCase()),
          Effect.orElseSucceed(() => false),
        ),
      { concurrency: "unbounded" },
    );
    if (serving.length === 1) {
      learnedHosts.set(host, serving[0]!.id);
      return serving[0]!.host.toLowerCase();
    }
    aliasMisses.set(key, now + ALIAS_MISS_TTL_MS);
    return null;
  });
  const request = <S extends Schema.Top>(
    remote: Effect.Success<ReturnType<typeof resolve>>,
    path: string,
    schema: S,
  ) =>
    api
      .request(remote.instance, path, schema)
      .pipe(Effect.mapError((e) => fail("read", e.detail, e.status)));
  const read = Effect.fn("GiteaPullRequest.read")(function* (
    input: ProviderRepositoryRef & { number: number },
  ) {
    const remote = yield* resolve(input);
    const path = GiteaApi.repositoryPath(remote.repository);
    const pr = yield* request(remote, `${path}/pulls/${input.number}`, Json.PullRequest);
    if (pr.base.repo?.full_name.toLowerCase() !== remote.repository.toLowerCase())
      return yield* fail("read", "Gitea returned a pull request from another repository.");
    return {
      remote,
      path,
      pr: { ...pr, html_url: giteaPullRequestUrl(remote.instance, remote.repository, pr.number) },
    };
  });
  // Gitea can clamp the requested limit. An empty page, not a short one, ends a walk.
  const pages = <S extends Schema.Top>(
    remote: Effect.Success<ReturnType<typeof resolve>>,
    path: string,
    schema: S,
  ) =>
    Effect.gen(function* () {
      const items: Array<S["Type"]> = [];
      for (let page = 1; page <= 20; page++) {
        const batch = yield* request(
          remote,
          `${path}${path.includes("?") ? "&" : "?"}page=${page}&limit=50`,
          Schema.Array(schema),
        );
        if (batch.length === 0) return { items, truncated: false };
        items.push(...batch);
      }
      return { items, truncated: true };
    });
  const unsupported = () =>
    Effect.fail(
      fail(
        "write",
        "Gitea pull requests are read-only in the browser. Open Gitea to make this change.",
      ),
    );
  const provider: PullRequestProviderApi = {
    kind: "gitea",
    capabilities,
    resolveHostAlias,
    getViewer: (input) =>
      resolve(input).pipe(
        Effect.flatMap((remote) => request(remote, "/user", Json.User)),
        Effect.map((u) => u.login),
      ),
    listChangeRequests: (input) =>
      Effect.gen(function* () {
        const remote = yield* resolve(input);
        const path = `${GiteaApi.repositoryPath(remote.repository)}/pulls?state=${input.state === "merged" ? "closed" : input.state}&sort=recentupdate`;
        const offset = input.cursor?.delivered ?? 0;
        const matching = [];
        // Stop as soon as the next slice is known, rather than walking the entire repository.
        for (let page = 1; page <= 1000; page++) {
          const batch = yield* request(
            remote,
            `${path}&page=${page}&limit=50`,
            Schema.Array(Json.PullRequest),
          );
          for (const raw of batch) {
            if (raw.base.repo?.full_name.toLowerCase() !== remote.repository.toLowerCase())
              return yield* fail("list", "Gitea returned a pull request from another repository.");
            const pr = Json.toChangeRequest({
              ...raw,
              html_url: giteaPullRequestUrl(remote.instance, remote.repository, raw.number),
            });
            if (
              (input.state === "all" || pr.state === input.state) &&
              (input.involvement === "all" ||
                (input.involvement === "authored"
                  ? pr.author?.login.toLowerCase() === input.viewer.toLowerCase()
                  : pr.reviewRequestLogins.some(
                      (login) => login.toLowerCase() === input.viewer.toLowerCase(),
                    )))
            )
              matching.push(pr);
          }
          if (batch.length === 0 || matching.length > offset + input.limit) {
            return {
              items: matching.slice(offset, offset + input.limit),
              truncated: matching.length > offset + input.limit,
              continues: true,
            };
          }
        }
        return yield* fail("list", "Gitea pull-request pagination exceeded 1000 pages.");
      }),
    getChangeRequestSummary: (input) =>
      read(input).pipe(Effect.map(({ pr }) => Json.toChangeRequest(pr))),
    getChangeRequest: (input) =>
      Effect.gen(function* () {
        const { remote, path, pr } = yield* read(input);
        const checks = [];
        for (let page = 1; page <= 20; page++) {
          const batch = yield* request(
            remote,
            `${path}/commits/${encodeURIComponent(pr.head.sha)}/status?page=${page}&limit=50`,
            Json.CombinedStatus,
          );
          checks.push(...(batch.statuses ?? []).map(Json.toCheck));
          if (checks.length >= batch.total_count) break;
          if ((batch.statuses?.length ?? 0) === 0 || page === 20)
            return yield* fail(
              "checks",
              "Gitea did not return all CI checks. Open Gitea for the complete status.",
            );
        }
        return {
          ...Json.toChangeRequest(pr),
          body: pr.body ?? "",
          changedFiles: pr.changed_files ?? 0,
          closedAt: pr.closed_at ?? null,
          mergedAt: pr.merged_at ?? null,
          reviewers: (pr.requested_reviewers ?? []).flatMap((u) => {
            const a = Json.actor(u);
            return a ? [a] : [];
          }),
          checks,
          mergeCapabilities: { merge: false, squash: false, rebase: false },
          viewerPermissions: permissions,
        };
      }),
    getChangeRequestActivity: (input) =>
      Effect.gen(function* () {
        const { remote, path, pr } = yield* read(input);
        const [conversation, reviews, commits] = yield* Effect.all(
          [
            pages(remote, `${path}/issues/${input.number}/comments`, Json.Comment),
            pages(remote, `${path}/pulls/${input.number}/reviews`, Json.Review),
            pages(remote, `${path}/pulls/${input.number}/commits`, Json.Commit),
          ],
          { concurrency: 3 },
        );
        const comments: PullRequestComment[] = conversation.items.map((c) => ({
          id: String(c.id),
          kind: "issue-comment",
          author: Json.actor(c.user),
          body: c.body,
          createdAt: c.created_at,
          url: c.html_url ?? null,
          path: null,
          reviewState: null,
        }));
        let truncated = conversation.truncated || reviews.truncated || commits.truncated;
        for (const review of reviews.items) {
          if (review.state === "PENDING" || review.state === "REQUEST_REVIEW") continue;
          comments.push({
            id: `review-${review.id}`,
            kind: "review",
            author: Json.actor(review.user),
            body: review.body,
            createdAt: review.submitted_at,
            url: review.html_url ?? null,
            path: null,
            reviewState: review.dismissed
              ? "DISMISSED"
              : review.state === "REQUEST_CHANGES"
                ? "CHANGES_REQUESTED"
                : review.state,
          });
          if (!review.comments_count) continue;
          const inline = yield* pages(
            remote,
            `${path}/pulls/${input.number}/reviews/${review.id}/comments`,
            Json.ReviewComment,
          );
          truncated ||= inline.truncated;
          comments.push(
            ...inline.items.map((c): PullRequestComment => ({
              id: String(c.id),
              kind: "review-comment",
              author: Json.actor(c.user),
              body: c.body,
              createdAt: c.created_at,
              url: c.html_url ?? null,
              path: c.path,
              reviewState: null,
            })),
          );
        }
        comments.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
        return {
          comments,
          commentCount: Math.max(comments.length, pr.comments ?? 0),
          commentsTruncated: truncated,
          reviewThreads: [],
          commits: commits.items.map((c) => ({
            oid: c.sha,
            messageHeadline: c.commit.message.split("\n")[0] ?? "",
            committedDate: c.commit.committer.date,
          })),
        };
      }),
    getViewerPermissions: () => Effect.succeed(permissions),
    getDiff: (input) =>
      Effect.gen(function* () {
        const { remote, path } = yield* read(input);
        if (input.commit !== undefined && !/^[a-f0-9]{40,64}$/i.test(input.commit))
          return yield* fail("diff", "Invalid commit SHA.");
        const patch = yield* api
          .text(
            remote.instance,
            input.commit === undefined
              ? `${path}/pulls/${input.number}.diff`
              : `${path}/git/commits/${input.commit}.diff`,
          )
          .pipe(Effect.mapError((e) => fail("diff", e.detail, e.status)));
        if (patch.length > 8_000_000)
          return yield* fail("diff", "This diff is too large to display. Open it in Gitea.");
        return { patch, truncated: false, nextCursor: null };
      }),
    getFileRevisions: (input) =>
      Effect.gen(function* () {
        const { patch } = yield* provider.getDiff(input);
        const revisions = new Map(parseDiffFileRevisions(patch));
        for (const path of input.paths) {
          if (!revisions.has(path)) revisions.set(path, "");
        }
        return { revisions, complete: true };
      }),
    runAction: unsupported,
    comment: unsupported,
    submitReview: unsupported,
    listReviewerCandidates: unsupported,
    setReviewerRequest: unsupported,
    replyToThread: unsupported,
    setReaction: unsupported,
    setThreadResolution: unsupported,
  };
  return provider;
});
