import { expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import { ClientSettingsSchema, ClientSettingsPatch } from "./settings.ts";

const decode = Schema.decodeUnknownSync(ClientSettingsSchema);
const decodePatch = Schema.decodeUnknownSync(ClientSettingsPatch);
const encode = Schema.encodeSync(ClientSettingsSchema);

it("defaults old settings to all projects and preserves persisted hidden scopes", () => {
  expect(decode({})).toHaveProperty("sidebarHiddenProjectKeys", []);
  const selection = { sidebarHiddenProjectKeys: ["general-chat", "environment:project"] };
  expect(encode(decode(selection))).toMatchObject(selection);
  expect(decodePatch(selection)).toEqual(selection);
});

it("unrelated settings patches preserve project selections", () => {
  const saved = decode({ sidebarHiddenProjectKeys: ["remote:project"] });
  const patch = decodePatch({ wordWrap: false });
  expect(patch).not.toHaveProperty("sidebarHiddenProjectKeys");
  expect(encode({ ...saved, ...patch })).toHaveProperty("sidebarHiddenProjectKeys", [
    "remote:project",
  ]);
});
