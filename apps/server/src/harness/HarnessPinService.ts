import { HarnessReadError, type HarnessSetCheckPinnedInput } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Semaphore from "effect/Semaphore";
import * as Settings from "../serverSettings.ts";

/** Pins are a list in server settings, so they stay small; a few dozen is already a crowded top. */
export const MAX_PINNED_CHECKS = 100;

/**
 * Pins Harness checks to the top of the checks list, or unpins them. The one method behind the
 * client RPC and the `harness_check_pin` MCP tool. Pins live in server settings
 * (`harnessPinnedCheckKeys`), so they persist per environment with no new storage; a key no check
 * reports any more is inert, and unpinning one removes it.
 */
export class HarnessPinService extends Context.Service<
  HarnessPinService,
  {
    /** Returns the pinned keys after the change. Pinning an already pinned key changes nothing. */
    readonly setPinned: (
      input: HarnessSetCheckPinnedInput,
    ) => Effect.Effect<ReadonlyArray<string>, HarnessReadError>;
  }
>()("t3/harness/HarnessPinService") {}

export const make = Effect.gen(function* () {
  const settings = yield* Settings.ServerSettingsService;
  // Read-modify-write of one list: two clients pinning at once must both land.
  const lock = yield* Semaphore.make(1);
  const failed = () => new HarnessReadError({ message: "Harness pins could not be saved." });
  return HarnessPinService.of({
    setPinned: ({ checkKey, pinned }) =>
      lock.withPermits(1)(
        Effect.gen(function* () {
          const current = (yield* settings.getSettings).harnessPinnedCheckKeys;
          if (pinned === current.includes(checkKey)) return current;
          if (pinned && current.length >= MAX_PINNED_CHECKS)
            return yield* new HarnessReadError({
              message: `At most ${MAX_PINNED_CHECKS} checks can be pinned.`,
            });
          const next = pinned ? [...current, checkKey] : current.filter((key) => key !== checkKey);
          return (yield* settings.updateSettings({ harnessPinnedCheckKeys: next }))
            .harnessPinnedCheckKeys;
        }).pipe(Effect.catchTags({ ServerSettingsError: () => Effect.fail(failed()) })),
      ),
  });
});

export const layer = Layer.effect(HarnessPinService, make);
