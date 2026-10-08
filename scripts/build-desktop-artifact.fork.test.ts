import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";

import {
  createBuildConfig,
  renderMacCodeSigningEntitlements,
  resolveDesktopUpdateChannel,
} from "./build-desktop-artifact.ts";

it.layer(NodeServices.layer)("build-desktop-artifact fork", (it) => {
  it("routes fork-published nightly versions to the nightly updater channel", () => {
    // sync-upstream.yml tags fork nightlies as vX.Y.Z-nightly.YYYYMMDD.R-fork.N
    // so electron-updater picks up upgrades. The packager must agree.
    assert.equal(resolveDesktopUpdateChannel("0.0.21-nightly.20260421.88-fork.1"), "nightly");
    assert.equal(resolveDesktopUpdateChannel("0.0.22-nightly.20260423.108-fork.3"), "nightly");
  });

  it("keeps stable -fork.N interim versions on the latest channel", () => {
    // Stable fork-only patch builds (vX.Y.Z-fork.N per LLM_INSTRUCTIONS.md)
    // must still go to the `latest` channel, not the nightly one.
    assert.equal(resolveDesktopUpdateChannel("0.0.22-fork.1"), "latest");
  });

  it.effect(
    "adds hardened-runtime entitlements without provisioning profile for signed macOS builds",
    () =>
      Effect.gen(function* () {
        const entitlements = renderMacCodeSigningEntitlements();
        const config = yield* createBuildConfig(
          "stable",
          "mac",
          "dmg",
          "1.2.3",
          true,
          false,
          undefined,
          {
            entitlementsPath: "/tmp/entitlements.mac.plist",
          },
        );

        const mac = config.mac as Record<string, unknown>;
        assert.equal(config.appId, "com.t3tools.t3code.fork");
        assert.equal(mac.entitlements, "/tmp/entitlements.mac.plist");
        assert.notProperty(mac, "provisioningProfile");
        assert.include(entitlements, "<key>com.apple.security.cs.allow-jit</key>");
        assert.include(
          entitlements,
          "<key>com.apple.security.cs.allow-unsigned-executable-memory</key>",
        );
        assert.include(entitlements, "<key>com.apple.security.cs.disable-library-validation</key>");
        assert.notInclude(entitlements, "com.apple.application-identifier");
        assert.notInclude(entitlements, "com.apple.developer.associated-domains");
      }).pipe(Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env: {} })))),
  );
});
