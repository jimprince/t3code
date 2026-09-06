import type { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as ProviderEventLoggers from "../../provider/Layers/ProviderEventLoggers.ts";

/** Release only after lifecycle final frames have drained; a later write opens a fresh sink. */
export const releaseThreadLogs = Effect.fn("releaseThreadLogs")(function* (
  threadIds: Iterable<ThreadId>,
) {
  const loggers = yield* Effect.serviceOption(ProviderEventLoggers.ProviderEventLoggers);
  if (Option.isNone(loggers)) return;
  const logger = loggers.value.canonical ?? loggers.value.native;
  if (!logger?.releaseThread) return;
  yield* Effect.forEach(threadIds, (id) => logger.releaseThread!(id), { discard: true });
});
