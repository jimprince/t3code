import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";

import type { ServerConfigShape } from "../../config.ts";
import { ServerConfig } from "../../config.ts";
import { BootstrapCredentialService } from "../Services/BootstrapCredentialService.ts";
import { BootstrapCredentialServiceLive } from "./BootstrapCredentialService.ts";

const makeServerConfigLayer = (
  overrides?: Partial<Pick<ServerConfigShape, "desktopBootstrapToken">>,
) =>
  Layer.effect(
    ServerConfig,
    Effect.gen(function* () {
      const config = yield* ServerConfig;
      return {
        ...config,
        ...overrides,
      } satisfies ServerConfigShape;
    }),
  ).pipe(
    Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-auth-bootstrap-test-" })),
  );

const makeBootstrapCredentialLayer = (
  overrides?: Partial<Pick<ServerConfigShape, "desktopBootstrapToken">>,
) => BootstrapCredentialServiceLive.pipe(Layer.provide(makeServerConfigLayer(overrides)));

it.layer(NodeServices.layer)("BootstrapCredentialServiceLive", (it) => {
  it.effect("issues one-time bootstrap tokens that can only be consumed once", () =>
    Effect.gen(function* () {
      const bootstrapCredentials = yield* BootstrapCredentialService;
      const token = yield* bootstrapCredentials.issueOneTimeToken();
      const first = yield* bootstrapCredentials.consume(token);
      const second = yield* Effect.flip(bootstrapCredentials.consume(token));

      expect(first.method).toBe("one-time-token");
      expect(second._tag).toBe("BootstrapCredentialError");
      expect(second.message).toContain("Unknown bootstrap credential");
    }).pipe(Effect.provide(makeBootstrapCredentialLayer())),
  );

  it.effect("atomically consumes a one-time token when multiple requests race", () =>
    Effect.gen(function* () {
      const bootstrapCredentials = yield* BootstrapCredentialService;
      const token = yield* bootstrapCredentials.issueOneTimeToken();
      const results = yield* Effect.all(
        Array.from({ length: 8 }, () => Effect.result(bootstrapCredentials.consume(token))),
        {
          concurrency: "unbounded",
        },
      );

      const successes = results.filter((result) => result._tag === "Success");
      const failures = results.filter((result) => result._tag === "Failure");

      expect(successes).toHaveLength(1);
      expect(failures).toHaveLength(7);
      for (const failure of failures) {
        expect(failure.failure._tag).toBe("BootstrapCredentialError");
        expect(failure.failure.message).toContain("Unknown bootstrap credential");
      }
    }).pipe(Effect.provide(makeBootstrapCredentialLayer())),
  );

  it.effect("seeds the desktop bootstrap credential as a one-time grant", () =>
    Effect.gen(function* () {
      const bootstrapCredentials = yield* BootstrapCredentialService;
      const first = yield* bootstrapCredentials.consume("desktop-bootstrap-token");
      const second = yield* Effect.flip(bootstrapCredentials.consume("desktop-bootstrap-token"));

      expect(first.method).toBe("desktop-bootstrap");
      expect(second._tag).toBe("BootstrapCredentialError");
    }).pipe(
      Effect.provide(
        makeBootstrapCredentialLayer({
          desktopBootstrapToken: "desktop-bootstrap-token",
        }),
      ),
    ),
  );
});
