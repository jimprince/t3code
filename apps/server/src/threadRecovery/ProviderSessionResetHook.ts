import {
  ThreadRecoveryError,
  type SessionResetInput,
  type ProviderSessionId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as ProviderSessionManager from "../orchestration-v2/ProviderSessionManager.ts";
import type {
  ProviderAdapterV2SessionRuntime,
  ProviderAdapterV2Error,
} from "../orchestration-v2/ProviderAdapter.ts";

/** Adapter owners provide exact-session teardown; absence never permits an instance-wide kill. */
export class ProviderSessionResetHook extends Context.Reference<{
  readonly reset: (
    input: SessionResetInput & {
      readonly providerSessionId: ProviderSessionId;
      readonly oldGeneration: number;
      readonly newGeneration: number;
    },
  ) => Effect.Effect<
    { readonly isolation: "session" | "thread"; readonly stopped: boolean },
    ThreadRecoveryError
  >;
}>("t3/threadRecovery/ProviderSessionResetHook", {
  defaultValue: () => ({
    reset: () =>
      Effect.fail(
        new ThreadRecoveryError({
          code: "unsupported",
          message: "This provider has no isolated session reset hook.",
        }),
      ),
  }),
}) {}

// The manager owns residency; adapter owners add resetThread without another registry API.

type ResettableRuntime = ProviderAdapterV2SessionRuntime & {
  readonly resetThread?: (
    input: Pick<SessionResetInput, "threadId" | "runId">,
  ) => Effect.Effect<
    { readonly isolation: "session" | "thread"; readonly stopped: boolean },
    ProviderAdapterV2Error
  >;
};
export const layer = Layer.effect(
  ProviderSessionResetHook,
  Effect.gen(function* () {
    const sessions = yield* ProviderSessionManager.ProviderSessionManagerV2;
    return {
      reset: (
        input: Parameters<Context.Service.Shape<typeof ProviderSessionResetHook>["reset"]>[0],
      ) =>
        Effect.gen(function* () {
          const runtime = yield* sessions.get(input.providerSessionId).pipe(
            Effect.mapError(
              () =>
                new ThreadRecoveryError({
                  code: "teardown",
                  message: "Could not look up exact session runtime.",
                }),
            ),
          );
          if (Option.isNone(runtime)) return { isolation: "session" as const, stopped: true };
          const resettable: ResettableRuntime = runtime.value;
          if (!resettable.resetThread)
            return yield* new ThreadRecoveryError({
              code: "unsupported",
              message: "Session fenced; this adapter does not support isolated reset.",
            });
          const result = yield* resettable
            .resetThread({ threadId: input.threadId, runId: input.runId })
            .pipe(
              Effect.mapError(
                () =>
                  new ThreadRecoveryError({
                    code: "teardown",
                    message: "Session fenced; isolated adapter teardown failed.",
                  }),
              ),
            );
          return result;
        }),
    };
  }),
);
