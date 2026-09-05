import {
  SourceControlProviderError,
  type ChangeRequest,
  type GiteaInstanceConfig,
} from "@t3tools/contracts";
import { resolveGiteaRemote } from "@t3tools/shared/sourceControl";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
} from "effect/unstable/http";
import { ServerSettingsService } from "../serverSettings.ts";
import * as SourceControlProvider from "./SourceControlProvider.ts";
import {
  providerAuth,
  type SourceControlApiDiscoverySpec,
} from "./SourceControlProviderDiscovery.ts";

const Repository = Schema.Struct({ id: Schema.Number, full_name: Schema.String });
const Ref = Schema.Struct({
  ref: Schema.String,
  label: Schema.optional(Schema.NullOr(Schema.String)),
  repo: Schema.NullOr(Repository),
});
const PullRequest = Schema.Struct({
  number: Schema.Number,
  title: Schema.String,
  html_url: Schema.String,
  state: Schema.Literals(["open", "closed"]),
  merged: Schema.Boolean,
  updated_at: Schema.NullOr(Schema.String),
  head: Ref,
  base: Ref,
});

export const make = Effect.gen(function* () {
  const settings = yield* ServerSettingsService;
  const client = yield* HttpClient.HttpClient;
  const request = Effect.fn("Gitea.request")(function* <S extends Schema.Top>(
    instance: GiteaInstanceConfig,
    path: string,
    schema: S,
    cwd: string,
  ) {
    const response = yield* client
      .execute(
        HttpClientRequest.get(`${instance.apiOrigin.replace(/\/$/, "")}/api/v1${path}`, {
          headers: instance.token
            ? { authorization: `token ${instance.token}`, accept: "application/json" }
            : { accept: "application/json" },
        }),
      )
      .pipe(
        Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
        Effect.timeout("10 seconds"),
        Effect.mapError(
          () =>
            new SourceControlProviderError({
              provider: "gitea",
              operation: "request",
              cwd,
              detail: "Could not reach the configured Gitea API.",
            }),
        ),
      );
    if (response.status < 200 || response.status >= 300)
      return yield* new SourceControlProviderError({
        provider: "gitea",
        operation: "request",
        cwd,
        detail: `Gitea API returned HTTP ${response.status}.`,
      });
    return yield* HttpClientResponse.schemaBodyJson(schema)(response).pipe(
      Effect.timeout("10 seconds"),
      Effect.mapError(
        () =>
          new SourceControlProviderError({
            provider: "gitea",
            operation: "request",
            cwd,
            detail: "Invalid Gitea API response.",
          }),
      ),
    );
  });
  const unavailable = (operation: string, cwd: string) =>
    new SourceControlProviderError({
      provider: "gitea",
      operation,
      cwd,
      detail: "This Gitea integration currently supports branch pull-request badges only.",
    });
  const provider = SourceControlProvider.SourceControlProvider.of({
    kind: "gitea",
    listChangeRequests: Effect.fn("Gitea.listChangeRequests")(function* (input) {
      const config = yield* settings.getSettings.pipe(
        Effect.mapError(() => unavailable("settings", input.cwd)),
      );
      const remote =
        input.context && resolveGiteaRemote(input.context.remoteUrl, config.giteaInstances);
      if (!remote) return yield* unavailable("resolveRepository", input.cwd);
      const selector = SourceControlProvider.sourceControlRefFromInput(input);
      const branch = SourceControlProvider.sourceBranch(input);
      const expectedRepository =
        selector?.repository ??
        (selector?.owner
          ? `${selector.owner}/${remote.repository.split("/")[1]}`
          : remote.repository);
      const path = `/repos/${remote.repository.split("/").map(encodeURIComponent).join("/")}`;
      const results: ChangeRequest[] = [];
      const limit = Math.max(0, input.limit ?? 20);
      if (!limit) return results;
      // Do not apply the result limit before filtering: pages can contain other branches and forks.
      for (let page = 1; page <= 1000; page++) {
        const items = yield* request(
          remote.instance,
          `${path}/pulls?state=${input.state === "open" ? "open" : "all"}&sort=recentupdate&page=${page}&limit=50`,
          Schema.Array(PullRequest),
          input.cwd,
        );
        if (items.length === 0) return results;
        for (const pr of items) {
          const state = pr.merged ? "merged" : pr.state;
          // Gitea retains the original branch in label after replacing a deleted head.
          const headRefName =
            state !== "open" && pr.head.ref === `refs/pull/${pr.number}/head` && pr.head.label
              ? pr.head.label
              : pr.head.ref;
          if (
            headRefName !== branch ||
            pr.head.repo?.full_name.toLowerCase() !== expectedRepository.toLowerCase() ||
            pr.base.repo?.full_name.toLowerCase() !== remote.repository.toLowerCase() ||
            (input.state !== "all" && state !== input.state)
          )
            continue;
          results.push({
            provider: "gitea",
            number: pr.number,
            title: pr.title,
            url: pr.html_url,
            baseRefName: pr.base.ref,
            headRefName,
            state,
            updatedAt: pr.updated_at ? DateTime.make(pr.updated_at) : Option.none(),
            isCrossRepository: pr.head.repo.id !== pr.base.repo.id,
            headRepositoryNameWithOwner: pr.head.repo.full_name,
            headRepositoryOwnerLogin: pr.head.repo.full_name.split("/")[0] ?? null,
          });
          if (results.length >= limit) return results;
        }
        // Continue until an empty page, even when an instance clamps the requested page size.
      }
      return yield* new SourceControlProviderError({
        provider: "gitea",
        operation: "listChangeRequests",
        cwd: input.cwd,
        detail: "Gitea pull-request pagination exceeded 1000 pages.",
      });
    }),
    getChangeRequest: (input) => unavailable("getChangeRequest", input.cwd),
    createChangeRequest: (input) => unavailable("createChangeRequest", input.cwd),
    getRepositoryCloneUrls: (input) => unavailable("getRepositoryCloneUrls", input.cwd),
    createRepository: (input) => unavailable("createRepository", input.cwd),
    getDefaultBranch: () => Effect.succeed(null),
    checkoutChangeRequest: (input) => unavailable("checkoutChangeRequest", input.cwd),
  });
  const discovery: SourceControlApiDiscoverySpec = {
    type: "api",
    kind: "gitea",
    label: "Gitea",
    installHint: "Configure Gitea instances and personal access tokens in Source Control settings.",
    probeAuth: Effect.gen(function* () {
      const { giteaInstances } = yield* settings.getSettings;
      if (!giteaInstances.length)
        return providerAuth({
          status: "unauthenticated",
          detail: "No Gitea instances configured.",
        });
      for (const instance of giteaInstances) {
        yield* request(instance, "/user", Schema.Struct({ login: Schema.String }), "");
      }
      return providerAuth({
        status: "authenticated",
        detail: `${giteaInstances.length} Gitea instance(s) authenticated.`,
      });
    }).pipe(
      Effect.catch(() =>
        Effect.succeed(
          providerAuth({
            status: "unauthenticated",
            detail:
              "Could not authenticate all configured Gitea instances. Check tokens and API origins.",
          }),
        ),
      ),
    ),
  };
  return { provider, discovery };
});
