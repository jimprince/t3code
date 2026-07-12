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
});
