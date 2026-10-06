import { SourceControlProviderInfo } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Cache from "effect/Cache";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import type * as SourceControlProvider from "./SourceControlProvider.ts";
import { ExecutableCacheGeneration } from "../fork/process/LaunchBudget.ts";
type Refinement = Effect.Effect<SourceControlProvider.SourceControlProviderContext | null>;
const RefinementInput = Schema.fromJsonString(
  Schema.Struct({
    cwd: Schema.String,
    context: Schema.NullOr(
      Schema.Struct({
        provider: SourceControlProviderInfo,
        remoteName: Schema.String,
        remoteUrl: Schema.String,
        requestedHost: Schema.optionalKey(Schema.String),
      }),
    ),
    generation: Schema.String,
  }),
);
const encodeGeneration = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const encodeRefinementInput = Schema.encodeSync(RefinementInput);
const decodeRefinementInput = Schema.decodeSync(RefinementInput);
/** A sweep retains each refinement until every link in that sweep has finished. */
export const ProviderRefinementScope = Context.Reference<Map<string, Refinement> | undefined>(
  "t3/ProviderRefinementScope",
  { defaultValue: () => undefined },
);

export const makeRefinementCache = (
  refine: (input: {
    cwd: string;
    context: SourceControlProvider.SourceControlProviderContext | null;
  }) => Refinement,
) =>
  Effect.gen(function* () {
    const explicitContextCache = yield* Cache.makeWith<
      string,
      SourceControlProvider.SourceControlProviderContext | null
    >(
      (key) => {
        const input = decodeRefinementInput(key);
        return refine({ cwd: input.cwd, context: input.context }).pipe(
          Effect.provideService(ExecutableCacheGeneration, input.generation),
        );
      },
      {
        capacity: 2048,
        timeToLive: (exit) =>
          Exit.isSuccess(exit)
            ? exit.value?.provider.kind === "unknown"
              ? Duration.minutes(10)
              : Duration.seconds(5)
            : Duration.zero,
      },
    );

    return (input: typeof RefinementInput.Type) =>
      Effect.gen(function* () {
        const key = encodeRefinementInput(input);
        const scope = yield* ProviderRefinementScope;
        if (scope === undefined) return yield* Cache.get(explicitContextCache, key);
        let refinement = scope.get(key);
        if (refinement === undefined) {
          refinement = yield* Effect.cached(Cache.get(explicitContextCache, key));
          scope.set(key, refinement);
        }
        return yield* refinement;
      });
  });
export const providerRefinementGeneration = encodeGeneration;
