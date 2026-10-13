import { it } from "@effect/vitest";
import { expect } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Pin from "./HarnessPinService.ts";
import * as Settings from "../serverSettings.ts";

const layer = Pin.layer.pipe(Layer.provideMerge(Settings.layerTest()));
it.effect("pins and unpins unknown keys idempotently, preserving order and sibling settings", () =>
  Effect.gen(function* () {
    const pin = yield* Pin.HarnessPinService;
    const settings = yield* Settings.ServerSettingsService;
    yield* settings.updateSettings({
      enableProviderUpdateChecks: false,
      harnessPinnedCheckKeys: ["a", "a", "b"],
    });
    expect((yield* settings.getSettings).harnessPinnedCheckKeys).toEqual(["a", "b"]);
    expect(yield* pin.setPinned({ checkKey: "a", pinned: true })).toEqual(["a", "b"]);
    expect(yield* pin.setPinned({ checkKey: "unknown:key", pinned: true })).toEqual([
      "a",
      "b",
      "unknown:key",
    ]);
    expect(yield* pin.setPinned({ checkKey: "a", pinned: false })).toEqual(["b", "unknown:key"]);
    expect(yield* pin.setPinned({ checkKey: "absent", pinned: false })).toEqual([
      "b",
      "unknown:key",
    ]);
    expect((yield* settings.getSettings).enableProviderUpdateChecks).toBe(false);
  }).pipe(Effect.provide(layer)),
);
it.effect("serializes simultaneous pins without losing either key", () =>
  Effect.gen(function* () {
    const pin = yield* Pin.HarnessPinService;
    yield* Effect.all(
      [
        pin.setPinned({ checkKey: "a", pinned: true }),
        pin.setPinned({ checkKey: "b", pinned: true }),
      ],
      { concurrency: "unbounded" },
    );
    const settings = yield* Settings.ServerSettingsService;
    expect(new Set((yield* settings.getSettings).harnessPinnedCheckKeys)).toEqual(
      new Set(["a", "b"]),
    );
  }).pipe(Effect.provide(layer)),
);
it.effect("rejects excessive pins and invalid keys without changing the saved list", () =>
  Effect.gen(function* () {
    const pin = yield* Pin.HarnessPinService;
    const settings = yield* Settings.ServerSettingsService;
    const keys = Array.from({ length: 200 }, (_, i) => `key:${i}`);
    yield* settings.updateSettings({ harnessPinnedCheckKeys: keys });
    expect(
      yield* pin.setPinned({ checkKey: "overflow", pinned: true }).pipe(Effect.flip),
    ).toMatchObject({ _tag: "HarnessPinError" });
    expect(yield* pin.setPinned({ checkKey: "", pinned: true }).pipe(Effect.flip)).toMatchObject({
      _tag: "HarnessPinError",
    });
    expect(
      yield* pin.setPinned({ checkKey: "x".repeat(513), pinned: true }).pipe(Effect.flip),
    ).toMatchObject({ _tag: "HarnessPinError" });
    expect((yield* settings.getSettings).harnessPinnedCheckKeys).toEqual(keys);
    expect(yield* pin.setPinned({ checkKey: keys[0]!, pinned: true })).toEqual(keys);
    expect((yield* pin.setPinned({ checkKey: keys[0]!, pinned: false })).length).toBe(199);
  }).pipe(Effect.provide(layer)),
);
