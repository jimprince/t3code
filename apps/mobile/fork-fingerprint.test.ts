// @effect-diagnostics nodeBuiltinImport:off
import * as NodeModule from "node:module";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";

const require = NodeModule.createRequire(import.meta.url);
const expoRequire = NodeModule.createRequire(require.resolve("expo/package.json"));
const { loadConfigAsync } = expoRequire("@expo/fingerprint/build/Config.js");

describe("native fork fingerprint configuration", () => {
  it("loads normalization and keeps major-version isolation through Expo's real loader", async () => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "fork-fingerprint-"));
    try {
      for (const name of ["fingerprint.config.js", "fingerprint.config.cjs", "app.config.ts"]) {
        NodeFS.copyFileSync(new URL(name, import.meta.url), NodePath.join(root, name));
      }
      const current = await loadConfigAsync(root);
      expect(current.extraSources).toContainEqual({ type: "contents", id: "appMajorVersion", contents: "2" });
      const source = { type: "contents", id: "IosAutolinkingConfig" };
      const input = "../../node_modules/.pnpm/expo@58/node_modules/expo";
      expect(current.fileHookTransform(source, input, true)).toBe("../../node_modules/expo");
      expect(current.fileHookTransform({ ...source, id: "other" }, input, true)).toBe(input);
      NodeFS.writeFileSync(NodePath.join(root, "app.config.ts"), NodeFS.readFileSync(NodePath.join(root, "app.config.ts"), "utf8").replace('version: "2.0.0"', 'version: "1.0.0"'));
      delete require.cache[require.resolve(NodePath.join(root, "fingerprint.config.js"))];
      const legacy = await loadConfigAsync(root);
      expect(legacy.extraSources).toContainEqual({ type: "contents", id: "appMajorVersion", contents: "1" });
      expect(legacy.extraSources).not.toEqual(current.extraSources);
    } finally {
      NodeFS.rmSync(root, { recursive: true, force: true });
    }
  });
});
