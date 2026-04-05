/**
 * RoutingTextGeneration – Dispatches text generation requests to either the
 * Codex CLI or Claude CLI implementation based on the provider in each
 * request input.
 *
 * When `modelSelection.provider` is `"claudeAgent"` the request is forwarded to
 * the Claude layer; when it is `"codex"` the request is forwarded to the Codex
 * layer. Unsupported providers fail at the routing boundary with a typed
 * `TextGenerationError`.
 *
 * @module RoutingTextGeneration
 */
import { Effect, Layer, ServiceMap } from "effect";
import { TextGenerationError, type ProviderKind } from "@t3tools/contracts";

import {
  TextGeneration,
  type TextGenerationProvider,
  type TextGenerationShape,
} from "../Services/TextGeneration.ts";
import { CodexTextGenerationLive } from "./CodexTextGeneration.ts";
import { ClaudeTextGenerationLive } from "./ClaudeTextGeneration.ts";

// ---------------------------------------------------------------------------
// Internal service tags so both concrete layers can coexist.
// ---------------------------------------------------------------------------

class CodexTextGen extends ServiceMap.Service<CodexTextGen, TextGenerationShape>()(
  "t3/git/Layers/RoutingTextGeneration/CodexTextGen",
) {}

class ClaudeTextGen extends ServiceMap.Service<ClaudeTextGen, TextGenerationShape>()(
  "t3/git/Layers/RoutingTextGeneration/ClaudeTextGen",
) {}

// ---------------------------------------------------------------------------
// Routing implementation
// ---------------------------------------------------------------------------

const makeRoutingTextGeneration = Effect.gen(function* () {
  const codex = yield* CodexTextGen;
  const claude = yield* ClaudeTextGen;

  const unsupportedProvider = (
    operation: TextGenerationError["operation"],
    provider?: ProviderKind | TextGenerationProvider,
  ) =>
    new TextGenerationError({
      operation,
      detail: `Git text generation does not support provider "${provider ?? "unknown"}" yet.`,
    });

  return {
    generateCommitMessage: (input) => {
      switch (input.modelSelection.provider) {
        case "claudeAgent":
          return claude.generateCommitMessage(input);
        case "codex":
          return codex.generateCommitMessage(input);
        default:
          return Effect.fail(
            unsupportedProvider("generateCommitMessage", input.modelSelection.provider),
          );
      }
    },
    generatePrContent: (input) => {
      switch (input.modelSelection.provider) {
        case "claudeAgent":
          return claude.generatePrContent(input);
        case "codex":
          return codex.generatePrContent(input);
        default:
          return Effect.fail(
            unsupportedProvider("generatePrContent", input.modelSelection.provider),
          );
      }
    },
    generateBranchName: (input) => {
      switch (input.modelSelection.provider) {
        case "claudeAgent":
          return claude.generateBranchName(input);
        case "codex":
          return codex.generateBranchName(input);
        default:
          return Effect.fail(
            unsupportedProvider("generateBranchName", input.modelSelection.provider),
          );
      }
    },
    generateThreadTitle: (input) => {
      switch (input.modelSelection.provider) {
        case "claudeAgent":
          return claude.generateThreadTitle(input);
        case "codex":
          return codex.generateThreadTitle(input);
        default:
          return Effect.fail(
            unsupportedProvider("generateThreadTitle", input.modelSelection.provider),
          );
      }
    },
  } satisfies TextGenerationShape;
});

const InternalCodexLayer = Layer.effect(
  CodexTextGen,
  Effect.gen(function* () {
    const svc = yield* TextGeneration;
    return svc;
  }),
).pipe(Layer.provide(CodexTextGenerationLive));

const InternalClaudeLayer = Layer.effect(
  ClaudeTextGen,
  Effect.gen(function* () {
    const svc = yield* TextGeneration;
    return svc;
  }),
).pipe(Layer.provide(ClaudeTextGenerationLive));

export const RoutingTextGenerationLive = Layer.effect(
  TextGeneration,
  makeRoutingTextGeneration,
).pipe(Layer.provide(InternalCodexLayer), Layer.provide(InternalClaudeLayer));
