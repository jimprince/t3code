import { expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import { ClientSettingsSchema, ClientSettingsPatch } from "./settings.ts";

it("keeps Projects enabled for old settings and preserves the Threads opt-out", () => {
  expect(Schema.decodeUnknownSync(ClientSettingsSchema)({}).sidebarOrchestratorsEnabled).toBe(true);
  expect(
    Schema.decodeUnknownSync(ClientSettingsPatch)({ sidebarOrchestratorsEnabled: false })
      .sidebarOrchestratorsEnabled,
  ).toBe(false);
});
