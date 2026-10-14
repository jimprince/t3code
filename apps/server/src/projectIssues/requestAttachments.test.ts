import { expect } from "vite-plus/test";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { HttpClient, HttpClientResponse } from "effect/http";
import { ChatAttachmentId, type GiteaInstanceConfig } from "@t3tools/contracts";
import * as ServerConfig from "../config.ts";
import { createPendingAttachmentId } from "../attachmentStore.ts";
import { uploadRequestAttachments } from "./requestAttachments.ts";
import { parseRankTrailer, parsePlacedByTrailer } from "./requestOrder.logic.ts";

it.effect(
  "uploads app images to issue assets idempotently and preserves quote, rank and placer",
  () => {
    const instance: GiteaInstanceConfig = {
      id: "test",
      host: "tracker.test",
      sshAliases: [],
      sshPorts: [],
      apiOrigin: "https://tracker.test",
      webOrigin: "https://tracker.test",
      token: "",
    };
    const assets: Array<{ name: string; browser_download_url: string }> = [];
    let body =
      "## Brad's words\n\n> Keep this exactly  \n\n<!-- t3:placed-by %7B%22kind%22%3A%22brad%22%7D -->\n<!-- t3:rank 1024 -->";
    let uploads = 0;
    const client = HttpClient.make((request) => {
      const reply = (data: unknown) =>
        Effect.succeed(HttpClientResponse.fromWeb(request, new Response(JSON.stringify(data))));
      if (request.url.endsWith("/assets")) {
        if (request.method === "GET") return reply(assets);
        if (request.body._tag !== "FormData") return Effect.die("Expected a multipart attachment");
        const file = request.body.formData.get("attachment") as File;
        uploads++;
        const asset = {
          name: file.name,
          browser_download_url: "https://tracker.test/attachments/image",
        };
        assets.push(asset);
        return reply(asset);
      }
      if (request.method === "PATCH") {
        if (request.body._tag !== "Uint8Array") return Effect.die("Expected body JSON");
        body = JSON.parse(new TextDecoder().decode(request.body.body)).body;
      }
      return reply({ body });
    });
    return Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const id = ChatAttachmentId.make(createPendingAttachmentId());
      yield* fs.makeDirectory(config.attachmentsDir, { recursive: true });
      yield* fs.writeFile(path.join(config.attachmentsDir, `${id}.png`), new Uint8Array([1, 2, 3]));
      const attachment = {
        id,
        type: "image" as const,
        name: "pasted.png",
        mimeType: "image/png",
        sizeBytes: 3,
      };
      const target = { instance, host: "tracker.test", repository: "brad/test" };
      yield* uploadRequestAttachments(target, 12, [attachment], "head");
      yield* uploadRequestAttachments(target, 12, [attachment], "head");
      expect(uploads).toBe(1);
      expect(body).toContain("> Keep this exactly  ");
      expect(body).toContain("[pasted.png](https://tracker.test/attachments/image)");
      expect(parseRankTrailer(body)).toBe(1024);
      expect(parsePlacedByTrailer(body)).toEqual({ kind: "brad" });
    }).pipe(
      Effect.provideService(HttpClient.HttpClient, client),
      Effect.provide(
        ServerConfig.layerTest(process.cwd(), { prefix: "t3-request-assets-" }).pipe(
          Layer.provideMerge(NodeServices.layer),
        ),
      ),
    );
  },
);
