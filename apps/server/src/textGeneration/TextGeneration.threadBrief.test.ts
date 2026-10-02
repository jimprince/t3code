import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { describe, expect } from "vite-plus/test";

import { ProviderInstanceId } from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";

import type { ProviderInstance } from "../provider/ProviderDriver.ts";
import * as ProviderInstanceRegistry from "../provider/Services/ProviderInstanceRegistry.ts";
import * as SourceControlProviderRegistry from "../sourceControl/SourceControlProviderRegistry.ts";
import * as TextGeneration from "./TextGeneration.ts";

const brief = { needsYou: ["Approve J3 homing."], done: [], moving: [], blocked: [] };

function facade(textGeneration: Partial<TextGeneration.TextGeneration["Service"]>) {
  const instanceId = ProviderInstanceId.make("grok");
  const instance = { instanceId, textGeneration } as unknown as ProviderInstance;
  return TextGeneration.make.pipe(
    Effect.provideService(ProviderInstanceRegistry.ProviderInstanceRegistry, {
      getInstance: (id: ProviderInstanceId) =>
        Effect.succeed(id === instanceId ? instance : undefined),
    } as unknown as ProviderInstanceRegistry.ProviderInstanceRegistry["Service"]),
    Effect.provide(
      Layer.mock(SourceControlProviderRegistry.SourceControlProviderRegistry)({
        resolveLink: () => Effect.die("No link lookup expected"),
      }),
    ),
  );
}

const input = {
  cwd: "/srv/agents/k1",
  threadTitle: "t3-orchestrator",
  transcript: { turnCount: 1, lines: ["from arm-calib: done"] },
  modelSelection: createModelSelection(ProviderInstanceId.make("grok"), "grok-4"),
};

describe("TextGeneration.generateThreadBrief", () => {
  it.effect("delegates to a provider that supports briefs", () =>
    Effect.gen(function* () {
      const textGeneration = yield* facade({ generateThreadBrief: () => Effect.succeed(brief) });

      expect(yield* textGeneration.generateThreadBrief!(input)).toEqual(brief);
    }),
  );

  it.effect("names the supported providers when the selected one has no briefs", () =>
    Effect.gen(function* () {
      const textGeneration = yield* facade({});
      const error = yield* textGeneration.generateThreadBrief!(input).pipe(Effect.flip);

      expect(error.operation).toBe("generateThreadBrief");
      expect(error.detail).toContain("Codex or Claude");
    }),
  );
});
