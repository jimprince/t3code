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

  it.effect("does not silently take the fork side for the shared websocket runtime", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const repoRoot = yield* path.fromFileUrl(new URL("..", import.meta.url));
      const rebaseDriver = yield* fs.readFileString(
        path.join(repoRoot, "scripts/ci/reproduce-sync-upstream"),
      );
      const forkOwnershipPolicy = rebaseDriver.slice(
        rebaseDriver.indexOf("FORK_RESOLVE_FILES=("),
        rebaseDriver.indexOf("is_fork_owned_file()"),
      );
      const forkOwnedEntries = forkOwnershipPolicy
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0 && !line.startsWith("#"));

      assert.isAbove(forkOwnershipPolicy.length, 0);
      assert.notInclude(
        forkOwnedEntries,
        "apps/server/src/ws.ts",
        "REGRESSION: whole-file fork ownership discarded upstream server.probe changes",
      );
    }),
  );
});
