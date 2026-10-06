import * as Context from "effect/Context";
import * as Ref from "effect/Ref";
import * as Config from "effect/Config";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as EffectWorker from "../../orchestration-v2/EffectWorker.ts";

export const automaticStartupResumeAllowed = Config.Boolean("T3CODE_DISABLE_STARTUP_RESUME").pipe(
  Config.withDefault(false),
  Effect.map((disabled) => !disabled),
  Effect.orElseSucceed(() => false),
);

export class StartupResumePolicy extends Context.Service<
  StartupResumePolicy,
  {
    readonly markCommandReady: Effect.Effect<void>;
    readonly permits: (
      effect: import("../../orchestration-v2/EffectOutbox.ts").OrchestrationEffectV2,
    ) => Effect.Effect<boolean>;
  }
>()("t3/fork/recovery/StartupResumePolicy") {}

export const layer = Layer.effect(
  StartupResumePolicy,
  Effect.gen(function* () {
    const allowed = yield* automaticStartupResumeAllowed;
    const cutoff = yield* Ref.make(Number.POSITIVE_INFINITY);
    return StartupResumePolicy.of({
      markCommandReady: DateTime.now.pipe(
        Effect.flatMap((now) => Ref.set(cutoff, DateTime.toEpochMillis(now))),
      ),
      permits: (effect) =>
        Ref.get(cutoff).pipe(
          Effect.map((time) => {
            if (allowed) return true;
            const providerWork =
              effect.request.type.startsWith("provider-turn.") ||
              effect.request.type === "provider-runtime.continue" ||
              effect.request.type === "provider-thread.rollback" ||
              effect.request.type === "provider-thread.conversation-rewind" ||
              effect.request.type === "thread-title.generate" ||
              effect.request.type === "runtime-request.respond";
            return (
              !providerWork ||
              (effect.request.type !== "provider-runtime.continue" &&
                Date.parse(effect.createdAt) > time)
            );
          }),
        ),
    });
  }),
);

/** Reconciliation still runs. Only copied automatic provider work is withheld. */
export const executorLayer = Layer.effect(
  EffectWorker.OrchestrationEffectExecutorV2,
  Effect.gen(function* () {
    const executor = yield* EffectWorker.OrchestrationEffectExecutorV2;
    const policy = yield* StartupResumePolicy;
    return EffectWorker.OrchestrationEffectExecutorV2.of({
      execute: (effect, options) =>
        policy.permits(effect).pipe(
          Effect.flatMap((allowed) =>
            allowed
              ? executor.execute(effect, options)
              : Effect.logInfo("sandbox.startup-effect-withheld", {
                  effectId: effect.id,
                  type: effect.request.type,
                }),
          ),
        ),
    });
  }),
);
