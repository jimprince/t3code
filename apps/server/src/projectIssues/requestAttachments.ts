import { ProjectIssuesError, type UploadedAttachmentRef } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import * as ServerConfig from "../config.ts";
import {
  resolveAttachmentPathById,
  parseThreadSegmentFromAttachmentId,
  PENDING_ATTACHMENT_THREAD_SEGMENT,
} from "../attachmentStore.ts";
import type { GiteaRepositoryTarget } from "./projectIssues.logic.ts";
import {
  parseRankTrailer,
  parsePlacedByTrailer,
  replaceRankTrailer,
} from "./requestOrder.logic.ts";
import * as GiteaApi from "../sourceControl/GiteaApi.ts";
const Asset = Schema.Struct({ name: Schema.String, browser_download_url: Schema.String });
/** Upload only canonical app attachment IDs, never caller-supplied filesystem paths. */
export const uploadRequestAttachments = (
  target: GiteaRepositoryTarget,
  number: number,
  attachments: readonly UploadedAttachmentRef[],
  threadId?: string,
) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const fs = yield* FileSystem.FileSystem;
    const config = yield* ServerConfig.ServerConfig;
    const api = yield* GiteaApi.make;
    const issuePath = `${GiteaApi.repositoryPath(target.repository)}/issues/${number}`;
    const known = yield* api
      .request(target.instance, `${issuePath}/assets`, Schema.Array(Asset))
      .pipe(Effect.mapError((e) => new ProjectIssuesError({ message: e.detail })));
    const links: string[] = [];
    for (const attachment of attachments) {
      const owner = parseThreadSegmentFromAttachmentId(attachment.id);
      if (owner !== PENDING_ATTACHMENT_THREAD_SEGMENT && owner !== threadId)
        return yield* new ProjectIssuesError({
          message: "The attachment must be uploaded or owned by the filing thread.",
        });
      const file = resolveAttachmentPathById({
        attachmentsDir: config.attachmentsDir,
        attachmentId: attachment.id,
      });
      if (!file)
        return yield* new ProjectIssuesError({
          message: "The uploaded attachment is unavailable.",
        });
      const assetName = `${attachment.id}-${attachment.name}`;
      let asset = known.find((a) => a.name === assetName);
      if (!asset) {
        const bytes = yield* fs
          .readFile(file)
          .pipe(
            Effect.mapError(
              () => new ProjectIssuesError({ message: "Could not read the uploaded attachment." }),
            ),
          );
        const form = new FormData();
        form.append(
          "attachment",
          new Blob([new Uint8Array(bytes)], { type: attachment.mimeType }),
          assetName,
        );
        const response = yield* client
          .execute(
            HttpClientRequest.post(
              `${target.instance.apiOrigin.replace(/\/$/, "")}/api/v1${issuePath}/assets`,
              {
                headers: target.instance.token
                  ? { authorization: `token ${target.instance.token}` }
                  : {},
              },
            ).pipe(HttpClientRequest.bodyFormData(form)),
          )
          .pipe(
            Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
            Effect.timeout("10 seconds"),
            Effect.mapError(
              () => new ProjectIssuesError({ message: "Could not upload the issue attachment." }),
            ),
          );
        if (response.status < 200 || response.status >= 300)
          return yield* new ProjectIssuesError({ message: "Gitea rejected the issue attachment." });
        asset = yield* HttpClientResponse.schemaBodyJson(Asset)(response).pipe(
          Effect.mapError(
            () => new ProjectIssuesError({ message: "Invalid Gitea attachment response." }),
          ),
        );
      }
      links.push(
        `[${attachment.name.replaceAll("[", "").replaceAll("]", "")}](${asset.browser_download_url})`,
      );
    }
    const issue = yield* api
      .request(target.instance, issuePath, Schema.Struct({ body: Schema.NullOr(Schema.String) }))
      .pipe(Effect.mapError((e) => new ProjectIssuesError({ message: e.detail })));
    const missing = links.filter((l) => !(issue.body ?? "").includes(l));
    const original = issue.body ?? "";
    const rank = parseRankTrailer(original);
    const placer = parsePlacedByTrailer(original);
    const body = replaceRankTrailer(
      `${replaceRankTrailer(original, null)}\n\n${missing.join("\n")}`,
      rank,
      placer ?? undefined,
    );
    if (missing.length)
      yield* api
        .send(target.instance, "PATCH", issuePath, {
          body,
        })
        .pipe(Effect.mapError((e) => new ProjectIssuesError({ message: e.detail })));
  });
