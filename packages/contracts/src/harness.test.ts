import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import { HarnessSnapshot, HarnessCheckPinSetInput } from "./harness.ts";
import { ServerSettings, DEFAULT_SERVER_SETTINGS } from "./settings.ts";
import { clientRpcRequiredScopes } from "./clientRpcPermissions.ts";
import { AuthSettingsWriteScope } from "./auth.ts";

const decodeSnapshot = Schema.decodeUnknownSync(HarnessSnapshot);
const decodePinInput = Schema.decodeUnknownSync(HarnessCheckPinSetInput);
const encodeSettings = Schema.encodeSync(ServerSettings);
const decodeSettings = Schema.decodeUnknownSync(ServerSettings);

const snapshot = {
  schemaVersion: 1,
  environmentId: "environment",
  generatedAt: "2026-10-13T06:00:00.000Z",
  sources: [],
  agents: [],
  routines: [],
};
describe("Harness pin compatibility", () => {
  it("reads older snapshots without pins and new snapshots with pins", () => {
    expect(decodeSnapshot(snapshot).pinnedCheckKeys).toBeUndefined();
    expect(
      decodeSnapshot({ ...snapshot, pinnedCheckKeys: ["unknown:key"] }).pinnedCheckKeys,
    ).toEqual(["unknown:key"]);
    const { harnessPinnedCheckKeys: _pins, ...olderSettings } =
      encodeSettings(DEFAULT_SERVER_SETTINGS);
    expect(decodeSettings(olderSettings).harnessPinnedCheckKeys).toEqual([]);
  });
  it("bounds the input key and requires settings-write permission", () => {
    expect(() => decodePinInput({ checkKey: "", pinned: true })).toThrow();
    expect(() => decodePinInput({ checkKey: "x".repeat(513), pinned: true })).toThrow();
    expect(
      clientRpcRequiredScopes("harness.checkPin.set", { checkKey: "a", pinned: true }),
    ).toEqual([AuthSettingsWriteScope]);
  });
});
