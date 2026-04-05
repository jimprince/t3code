import * as NodeServices from "@effect/platform-node/NodeServices";
import { TextGenerationError } from "@t3tools/contracts";
import { it } from "@effect/vitest";
import { Effect, Layer, Result } from "effect";
import { expect } from "vitest";

import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { TextGeneration } from "../Services/TextGeneration.ts";
import { RoutingTextGenerationLive } from "./RoutingTextGeneration.ts";

const RoutingTextGenerationTestLayer = RoutingTextGenerationLive.pipe(
  Layer.provideMerge(ServerSettingsService.layerTest()),
  Layer.provideMerge(
    ServerConfig.layerTest(process.cwd(), {
      prefix: "t3code-routing-text-generation-test-",
    }),
  ),
  Layer.provideMerge(NodeServices.layer),
);

it.layer(RoutingTextGenerationTestLayer)("RoutingTextGenerationLive", (it) => {
  it.effect("fails early with typed TextGenerationError for unsupported providers", () =>
    Effect.gen(function* () {
      const textGeneration = yield* TextGeneration;
      const result = yield* textGeneration
        .generateCommitMessage({
          cwd: process.cwd(),
          branch: "feature/opencode-routing",
          stagedSummary: "M README.md",
          stagedPatch: "diff --git a/README.md b/README.md",
          modelSelection: {
            provider: "opencode",
            model: "openai/gpt-5.4",
          },
        })
        .pipe(Effect.result);

      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) {
        expect(result.failure).toBeInstanceOf(TextGenerationError);
        expect(result.failure.operation).toBe("generateCommitMessage");
        expect(result.failure.detail).toBe(
          'Git text generation does not support provider "opencode" yet.',
        );
        expect(result.failure.message).not.toContain("Invalid model selection");
      }
    }),
  );
});
