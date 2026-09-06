import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { ServerBootGeneration } from "../Services/ServerBootGeneration.ts";

export const makeServerBootGenerationLayer = (bootGenerationId: string) =>
  Layer.succeed(ServerBootGeneration, { bootGenerationId });

export const ServerBootGenerationLive = Layer.effect(
  ServerBootGeneration,
  Effect.gen(function* () {
    const crypto = yield* Crypto.Crypto;
    const bootGenerationId = yield* crypto.randomUUIDv4;
    return { bootGenerationId };
  }),
);
