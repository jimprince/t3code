import { describe, expect, it } from "vite-plus/test";
import { CommandId, ThreadId } from "@t3tools/contracts";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as EffectWorker from "../../orchestration-v2/EffectWorker.ts";
import type { OrchestrationEffectV2 } from "../../orchestration-v2/EffectOutbox.ts";
import * as Policy from "./StartupResumePolicy.ts";

const effect = (
  type: OrchestrationEffectV2["request"]["type"],
  createdAt = "2000-01-01T00:00:00Z",
) =>
  ({
    id: `effect:${type}`,
    commandId: CommandId.make("command:test"),
    threadId: ThreadId.make("thread:test"),
    request: { type },
    createdAt,
    status: "running",
    attemptCount: 1,
    availableAt: createdAt,
    leaseOwner: "test",
    leaseExpiresAt: null,
    updatedAt: createdAt,
    completedAt: null,
    lastError: null,
  }) as OrchestrationEffectV2;

for (const disabled of [undefined, "0", "1"]) {
  describe(`startup guard=${disabled ?? "absent"}`, () => {
    it("withholds copied automatic work only in sandbox and permits new explicit turns", async () => {
      const executed: string[] = [];
      const base = Layer.succeed(EffectWorker.OrchestrationEffectExecutorV2, {
        execute: (effect) =>
          Effect.sync(() => {
            executed.push(effect.request.type);
          }),
      });
      const layer = Policy.executorLayer.pipe(
        Layer.provide(base),
        Layer.provideMerge(Policy.layer),
        Layer.provide(
          ConfigProvider.layer(
            ConfigProvider.fromEnv({
              env: disabled === undefined ? {} : { T3CODE_DISABLE_STARTUP_RESUME: disabled },
            }),
          ),
        ),
      );
      await Effect.runPromise(
        Effect.gen(function* () {
          const executor = yield* EffectWorker.OrchestrationEffectExecutorV2;
          const policy = yield* Policy.StartupResumePolicy;
          for (const type of [
            "provider-runtime.continue",
            "provider-turn.start",
            "provider-turn.restart",
            "thread-title.generate",
            "provider-thread.rollback",
          ] as const) {
            yield* executor.execute(effect(type));
          }
          yield* executor.execute(effect("attachment.cleanup"));
          expect(executed).toEqual(
            disabled === "1"
              ? ["attachment.cleanup"]
              : [
                  "provider-runtime.continue",
                  "provider-turn.start",
                  "provider-turn.restart",
                  "thread-title.generate",
                  "provider-thread.rollback",
                  "attachment.cleanup",
                ],
          );
          yield* policy.markCommandReady;
          yield* executor.execute(effect("provider-runtime.continue", "2099-01-01T00:00:00Z"));
          yield* executor.execute(effect("provider-turn.start", "2099-01-01T00:00:00Z"));
          expect(executed.at(-1)).toBe("provider-turn.start");
          expect(executed.filter((type) => type === "provider-runtime.continue")).toHaveLength(
            disabled === "1" ? 0 : 2,
          );
        }).pipe(Effect.provide(layer), Effect.scoped),
      );
    });
  });
}
