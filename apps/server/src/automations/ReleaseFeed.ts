import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";

const Releases = Schema.Array(
  Schema.Struct({
    tag_name: Schema.String,
    html_url: Schema.String,
    published_at: Schema.NullOr(Schema.String),
  }),
);

export interface Release {
  readonly tag: string;
  readonly url: string;
  readonly publishedAt: string;
}

/**
 * The newest public GitHub release of a repository (`owner/name`), prereleases included, so
 * upstream nightlies and fork releases both count. Unauthenticated: callers poll a handful of
 * repositories every few minutes, well inside GitHub's anonymous limit.
 */
export class ReleaseFeed extends Context.Service<
  ReleaseFeed,
  { readonly latest: (repository: string) => Effect.Effect<Option.Option<Release>> }
>()("t3/automations/ReleaseFeed") {}

const make = Effect.gen(function* () {
  const client = yield* HttpClient.HttpClient;
  const latest = (repository: string) =>
    client
      .execute(
        HttpClientRequest.get(`https://api.github.com/repos/${repository}/releases?per_page=1`, {
          headers: { accept: "application/vnd.github+json", "user-agent": "t3code-automations" },
        }),
      )
      .pipe(
        Effect.flatMap(HttpClientResponse.filterStatusOk),
        Effect.flatMap(HttpClientResponse.schemaBodyJson(Releases)),
        Effect.map((releases) =>
          Option.fromNullishOr(releases[0]).pipe(
            Option.map((release) => ({
              tag: release.tag_name,
              url: release.html_url,
              publishedAt: release.published_at ?? "",
            })),
          ),
        ),
        Effect.catchCause((cause) =>
          Effect.logWarning("automation release poll failed", { repository, cause }).pipe(
            Effect.as(Option.none<Release>()),
          ),
        ),
      );
  return ReleaseFeed.of({ latest });
});

export const layer = Layer.effect(ReleaseFeed, make);
