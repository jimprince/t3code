import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import type * as SourceControlProvider from "../sourceControl/SourceControlProvider.ts";

export const UNSUPPORTED_PR_HOST_CACHE_TTL = Duration.minutes(10);

/** Resolve once per cache fill; unsupported hosts are successful skips, not transient failures. */
export const supportedPrHost = Effect.fn("supportedPrHost")(function* <E, R>(
  resolve: Effect.Effect<SourceControlProvider.SourceControlProvider["Service"], E, R>,
  cwd: string,
) {
  const provider = yield* resolve;
  if (provider.kind !== "unknown") return provider;
  yield* Effect.logWarning("No hosting provider handles this remote; skipping PR lookup.").pipe(
    Effect.annotateLogs({ operation: "prHostSupport", cwd }),
  );
  return null;
});
