import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as Settings from "../serverSettings.ts";
import * as HarnessPin from "./HarnessPinService.ts";

const layer = HarnessPin.layer.pipe(Layer.provideMerge(Settings.layerTest()));

it.effect("pins and unpins one check and reports the pinned keys each time", () =>
  Effect.gen(function* () {
    const pins = yield* HarnessPin.HarnessPinService;
    const settings = yield* Settings.ServerSettingsService;
    assert.deepStrictEqual(yield* pins.setPinned({ checkKey: "env:automation:a", pinned: true }), [
      "env:automation:a",
    ]);
    yield* pins.setPinned({ checkKey: "env:automation:b", pinned: true });
    // The same pin again, or an unpin of a key never pinned, changes nothing.
    yield* pins.setPinned({ checkKey: "env:automation:a", pinned: true });
    yield* pins.setPinned({ checkKey: "env:automation:never", pinned: false });
    assert.deepStrictEqual((yield* settings.getSettings).harnessPinnedCheckKeys, [
      "env:automation:a",
      "env:automation:b",
    ]);
    assert.deepStrictEqual(yield* pins.setPinned({ checkKey: "env:automation:a", pinned: false }), [
      "env:automation:b",
    ]);
    assert.deepStrictEqual(
      yield* pins.setPinned({ checkKey: "env:automation:b", pinned: false }),
      [],
    );
  }).pipe(Effect.provide(layer)),
);

it.effect("keeps both pins when two clients pin at once", () =>
  Effect.gen(function* () {
    const pins = yield* HarnessPin.HarnessPinService;
    yield* Effect.all(
      [
        pins.setPinned({ checkKey: "env:automation:a", pinned: true }),
        pins.setPinned({ checkKey: "env:automation:b", pinned: true }),
      ],
      { concurrency: "unbounded" },
    );
    const settings = yield* Settings.ServerSettingsService;
    assert.sameMembers(
      [...(yield* settings.getSettings).harnessPinnedCheckKeys],
      ["env:automation:a", "env:automation:b"],
    );
  }).pipe(Effect.provide(layer)),
);

it.effect("refuses a pin past the limit but still lets any pin be removed", () =>
  Effect.gen(function* () {
    const pins = yield* HarnessPin.HarnessPinService;
    const settings = yield* Settings.ServerSettingsService;
    const keys = Array.from(
      { length: HarnessPin.MAX_PINNED_CHECKS },
      (_, index) => `env:k${index}`,
    );
    yield* settings.updateSettings({ harnessPinnedCheckKeys: keys });
    const refused = yield* pins
      .setPinned({ checkKey: "env:one-more", pinned: true })
      .pipe(Effect.flip);
    assert.match(refused.message, /At most/);
    assert.lengthOf(yield* pins.setPinned({ checkKey: "env:k0", pinned: false }), keys.length - 1);
  }).pipe(Effect.provide(layer)),
);
