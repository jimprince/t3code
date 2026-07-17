import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

it.layer(NodeServices.layer)("sync-upstream workflow", (it) => {
  it.effect("preserves fork-owned CI documentation during upstream rebases", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const repoRoot = yield* path.fromFileUrl(new URL("..", import.meta.url));
      const rebaseDriver = yield* fs.readFileString(
        path.join(repoRoot, "scripts/ci/reproduce-sync-upstream"),
      );

      assert.include(rebaseDriver, "docs/operations/ci.md");
      assert.include(rebaseDriver, "docs/operations/release.md");
    }),
  );
});
