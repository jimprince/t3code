import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

const workflowPaths = [
  "mobile-eas-development.yml",
  "mobile-eas-preview.yml",
  "mobile-eas-production.yml",
] as const;

it.layer(NodeServices.layer)("mobile EAS workflows", (it) => {
  it.effect("installs the action-managed EAS CLI with npm", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const repoRoot = yield* path.fromFileUrl(new URL("..", import.meta.url));

      for (const workflowPath of workflowPaths) {
        const workflow = yield* fs.readFileString(
          path.join(repoRoot, ".github/workflows", workflowPath),
        );

        assert.include(workflow, "uses: expo/expo-github-action@v8");
        assert.include(workflow, "packager: npm");
        assert.notInclude(workflow, "packager: pnpm");
      }
    }),
  );

  it.effect("uses the repo package manager for development fingerprinting", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const repoRoot = yield* path.fromFileUrl(new URL("..", import.meta.url));
      const workflow = yield* fs.readFileString(
        path.join(repoRoot, ".github/workflows/mobile-eas-development.yml"),
      );

      assert.include(workflow, '"pnpm exec expo-updates fingerprint:generate --platform ios"');
      assert.notInclude(workflow, '"npx expo-updates fingerprint:generate --platform ios"');
    }),
  );

  it.effect("keeps production signing bootstrap local and production CI non-interactive", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const repoRoot = yield* path.fromFileUrl(new URL("..", import.meta.url));
      const workflow = yield* fs.readFileString(
        path.join(repoRoot, ".github/workflows/mobile-eas-production.yml"),
      );
      const releaseGuide = yield* fs.readFileString(
        path.join(repoRoot, "docs/operations/release.md"),
      );

      assert.include(workflow, "--non-interactive");
      assert.notInclude(workflow, "bootstrap_credentials");
      assert.notInclude(workflow, "env -u CI script");
      assert.notInclude(workflow, "EXPO_APPLE_TEAM_TYPE");
      assert.include(
        releaseGuide,
        "APP_VARIANT=production eas credentials:configure-build --platform ios --profile production",
      );
    }),
  );

  it.effect("does not configure the removed Expo Router package", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const repoRoot = yield* path.fromFileUrl(new URL("..", import.meta.url));
      const mobilePackage = yield* fs.readFileString(
        path.join(repoRoot, "apps/mobile/package.json"),
      );
      const appConfig = yield* fs.readFileString(path.join(repoRoot, "apps/mobile/app.config.ts"));

      assert.notInclude(mobilePackage, '"expo-router"');
      assert.notInclude(appConfig, '"expo-router"');
    }),
  );

  it.effect("references splash assets that exist in the EAS checkout", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const repoRoot = yield* path.fromFileUrl(new URL("..", import.meta.url));
      const appConfig = yield* fs.readFileString(path.join(repoRoot, "apps/mobile/app.config.ts"));

      for (const asset of ["splash-icon-dev.png", "splash-icon-prod.png"]) {
        assert.include(appConfig, `./assets/${asset}`);
        assert.isTrue(yield* fs.exists(path.join(repoRoot, "apps/mobile/assets", asset)));
      }
      assert.notInclude(appConfig, '"./assets/splash-icon.png"');
    }),
  );

  it.effect("uses upstream modular pod configuration instead of a fork Podfile patch", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const repoRoot = yield* path.fromFileUrl(new URL("..", import.meta.url));
      const appConfig = yield* fs.readFileString(path.join(repoRoot, "apps/mobile/app.config.ts"));

      assert.include(appConfig, '{ name: "GoogleUtilities", modular_headers: true }');
      assert.include(appConfig, '{ name: "RecaptchaInterop", modular_headers: true }');
      assert.isFalse(
        yield* fs.exists(path.join(repoRoot, "apps/mobile/plugins/withIosModularGooglePods.cjs")),
      );
    }),
  );

  it.effect("applies fork-owned Expo configuration only at export", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const repoRoot = yield* path.fromFileUrl(new URL("..", import.meta.url));
      const appConfig = yield* fs.readFileString(path.join(repoRoot, "apps/mobile/app.config.ts"));

      assert.include(appConfig, 'from "./fork-config.ts"');
      assert.include(appConfig, "applyMobileForkConfig(config, forkConfig)");
      assert.notInclude(appConfig, "com.brad.t3code");
    }),
  );
});
