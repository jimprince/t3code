import { expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Cause from "effect/Cause";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { layerMemory as SqlitePersistenceMemory } from "../persistence/Sqlite.ts";
import * as Metadata from "./MetadataStore.ts";
import { makeNestingService } from "./NestingService.ts";

const decodeMetadata = Schema.decodeUnknownEffect(Metadata.metadataJson);

it.effect(
  "initializes once per persistence environment, never in connection-scoped nesting constructors",
  () => {
    const initialize = vi.spyOn(Metadata, "initializeMetadata");
    return Effect.gen(function* () {
      for (let environment = 0; environment < 2; environment++) {
        yield* Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          expect(initialize).toHaveBeenCalledTimes(environment + 1);
          // The RPC layer constructs these helpers separately on each connection.
          for (let connection = 0; connection < 4; connection++) {
            for (let handler = 0; handler < 3; handler++) {
              const service = yield* makeNestingService(
                sql,
                () => Effect.succeed(null),
                () => Effect.void,
              );
              expect(yield* service.list()).toEqual([]);
            }
          }
          expect(initialize).toHaveBeenCalledTimes(environment + 1);
        }).pipe(Effect.provide(SqlitePersistenceMemory));
      }
    }).pipe(Effect.ensuring(Effect.sync(() => initialize.mockRestore())));
  },
);

it.effect("a failed startup does not poison subsequent persistence initialization", () => {
  const initialize = vi
    .spyOn(Metadata, "initializeMetadata")
    .mockImplementationOnce(() => Effect.die("interrupted import"));
  return Effect.gen(function* () {
    const read = Effect.gen(function* () {
      return yield* Metadata.listMetadata(yield* SqlClient.SqlClient);
    }).pipe(Effect.provide(SqlitePersistenceMemory));
    const failed = yield* Effect.exit(read);
    expect(Exit.isFailure(failed)).toBe(true);
    if (Exit.isFailure(failed)) expect(Cause.pretty(failed.cause)).toContain("interrupted import");
    expect(yield* read).toEqual([]);
    expect(initialize).toHaveBeenCalledTimes(2);
  }).pipe(Effect.ensuring(Effect.sync(() => initialize.mockRestore())));
});

it.effect(
  "keeps typed import failures in the existing migration error boundary with their cause and permits retry",
  () =>
    Effect.gen(function* () {
      const decoded = yield* Effect.exit(decodeMetadata("invalid"));
      if (Exit.isSuccess(decoded)) throw new Error("Expected malformed metadata to fail");
      const cause = Option.getOrThrow(Cause.findErrorOption(decoded.cause));
      const initialize = vi
        .spyOn(Metadata, "initializeMetadata")
        .mockImplementationOnce(() => Effect.fail(cause));
      yield* Effect.gen(function* () {
        const read = Effect.gen(function* () {
          return yield* Metadata.listMetadata(yield* SqlClient.SqlClient);
        }).pipe(Effect.provide(SqlitePersistenceMemory));
        const result = yield* Effect.exit(read);
        if (Exit.isSuccess(result)) throw new Error("Expected startup import to fail");
        const error = Option.getOrThrow(Cause.findErrorOption(result.cause));
        expect(error).toMatchObject({ _tag: "MigrationError", kind: "ImportError" });
        expect(Reflect.get(error, "cause")).toBe(cause);
        expect(yield* read).toEqual([]);
        expect(initialize).toHaveBeenCalledTimes(2);
      }).pipe(Effect.ensuring(Effect.sync(() => initialize.mockRestore())));
    }),
);
