import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import * as DesktopConfig from "./DesktopConfig.ts";

const defaultInput = {
  dirname: "/repo/apps/desktop/dist-electron",
  homeDirectory: "/Users/alice",
  platform: "darwin",
  processArch: "arm64",
  appVersion: "0.0.22",
  appPath: "/Applications/T3 Code.app/Contents/Resources/app.asar",
  isPackaged: false,
  resourcesPath: "/Applications/T3 Code.app/Contents/Resources",
  runningUnderArm64Translation: false,
} satisfies DesktopEnvironment.MakeDesktopEnvironmentInput;

const makeEnvironmentLayer = (
  overrides: Partial<DesktopEnvironment.MakeDesktopEnvironmentInput> = {},
  env: Record<string, string | undefined> = {},
) =>
  DesktopEnvironment.layer({
    ...defaultInput,
    ...overrides,
  }).pipe(Layer.provide(Layer.mergeAll(NodeServices.layer, DesktopConfig.layerTest(env))));

const makeEnvironment = (
  overrides: Partial<DesktopEnvironment.MakeDesktopEnvironmentInput> = {},
  env: Record<string, string | undefined> = {},
) =>
  DesktopEnvironment.DesktopEnvironment.pipe(Effect.provide(makeEnvironmentLayer(overrides, env)));

describe("DesktopEnvironment", () => {
  it.effect("uses the nightly app stage for nightly versions", () =>
    Effect.gen(function* () {
      const environment = yield* makeEnvironment({
        appVersion: "0.0.23-nightly.20260508.230-fork.1",
      });

      assert.equal(environment.displayName, "T3 Code (Nightly)");
      assert.deepEqual(environment.branding, {
        baseName: "T3 Code",
        displayName: "T3 Code (Nightly)",
        stageLabel: "Nightly",
      });
    }),
  );

  it.effect("uses a side-by-side identity for packaged Fork Dev builds", () =>
    Effect.gen(function* () {
      const environment = yield* makeEnvironment({
        isPackaged: true,
        desktopFlavor: "dev",
      });

      assert.equal(environment.isDevelopment, false);
      assert.equal(environment.isPackagedDevFlavor, true);
      assert.equal(environment.displayName, "T3 Code (Fork Dev)");
      assert.deepEqual(environment.branding, {
        baseName: "T3 Code",
        displayName: "T3 Code (Fork Dev)",
        stageLabel: "Fork Dev",
      });
      assert.equal(environment.appUserModelId, "com.t3tools.t3code.fork.dev");
      assert.equal(environment.linuxDesktopEntryName, "t3code-fork-dev.desktop");
      assert.equal(environment.linuxWmClass, "t3code-fork-dev");
      assert.equal(environment.userDataDirName, "t3code-fork-dev");
      assert.equal(environment.legacyUserDataDirName, "T3 Code (Fork Dev)");
    }),
  );
});
