import type { GiteaInstanceConfig } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
} from "effect/unstable/http";

/** Only sanitized diagnostics cross the adapter boundary; tokens and response bodies never do. */
class GiteaApiError extends Schema.TaggedError<GiteaApiError>()("GiteaApiError", {
  detail: Schema.String,
  status: Schema.optional(Schema.Number),
}) {}

export const repositoryPath = (repository: string) =>
  `/repos/${repository.split("/").map(encodeURIComponent).join("/")}`;

export const make = Effect.gen(function* () {
  const client = yield* HttpClient.HttpClient;
  const response = (instance: GiteaInstanceConfig, path: string, body?: unknown) =>
    client
      .execute(
        HttpClientRequest.make(body === undefined ? "GET" : "POST")(
          `${instance.apiOrigin.replace(/\/$/, "")}/api/v1${path}`,
          {
            headers: instance.token
              ? { authorization: `token ${instance.token}`, accept: "application/json" }
              : { accept: "application/json" },
          },
        ).pipe((req) => (body === undefined ? req : HttpClientRequest.bodyJsonUnsafe(req, body))),
      )
      .pipe(
        Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
        Effect.timeout("10 seconds"),
        Effect.mapError(
          () => new GiteaApiError({ detail: "Could not reach the configured Gitea API." }),
        ),
        Effect.flatMap((result) =>
          result.status >= 200 && result.status < 300
            ? Effect.succeed(result)
            : Effect.fail(
                new GiteaApiError({
                  status: result.status,
                  detail: `Gitea API returned HTTP ${result.status}.`,
                }),
              ),
        ),
      );
  const request = <S extends Schema.Top>(
    instance: GiteaInstanceConfig,
    path: string,
    schema: S,
    body?: unknown,
  ) =>
    response(instance, path, body).pipe(
      Effect.flatMap((result) =>
        HttpClientResponse.schemaBodyJson(schema)(result).pipe(
          Effect.timeout("10 seconds"),
          Effect.mapError(() => new GiteaApiError({ detail: "Invalid Gitea API response." })),
        ),
      ),
    );
  const text = (instance: GiteaInstanceConfig, path: string) =>
    response(instance, path).pipe(
      Effect.flatMap((result) =>
        result.text.pipe(
          Effect.timeout("10 seconds"),
          Effect.mapError(() => new GiteaApiError({ detail: "Could not read the Gitea diff." })),
        ),
      ),
    );
  return { request, text };
});
