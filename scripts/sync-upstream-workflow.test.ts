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
      assert.include(rebaseDriver, "--max-count=20");
      assert.include(rebaseDriver, "older fork commits");
    }),
  );

  it.effect("does not silently take the fork side for shared runtime integration files", () =>
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
      assert.notInclude(
        forkOwnedEntries,
        "apps/server/src/orchestration/Layers/ProjectionSnapshotQuery.ts",
        "REGRESSION: whole-file fork ownership discarded upstream thread snapshot fields",
      );
    }),
  );

  // The squash-model "collapses the fork delta to one replay commit on every
  // target" fixture used to live here. The driver now rebases the curated
  // topic stack instead of squashing (scripts/ci/reproduce-sync-upstream.test.ts
  // exercises that directly: topic commits survive as separate commits, a
  // fixup! is folded by --autosquash, and a genuine conflict reports the full
  // file list and restores the starting HEAD). This file keeps the
  // workflow-wiring-level assertions below instead of duplicating that
  // fixture coverage.

  it.effect("auto-resolves the near-fully fork-owned release workflow to the fork side", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const repoRoot = yield* path.fromFileUrl(new URL("..", import.meta.url));
      const driver = yield* fs.readFileString(
        path.join(repoRoot, "scripts/ci/reproduce-sync-upstream"),
      );

      const forkResolveBlock = driver.slice(
        driver.indexOf("FORK_RESOLVE_FILES=("),
        driver.indexOf(")", driver.indexOf("FORK_RESOLVE_FILES=(")),
      );
      assert.include(
        forkResolveBlock,
        ".github/workflows/release.yml",
        "REGRESSION: release.yml conflicts on nearly every sync because it is almost " +
          "entirely fork-owned (tag policy, concurrency groups, channel dispatch); it " +
          "must auto-resolve to the fork side rather than reconflict every cycle",
      );
    }),
  );

  it.effect("pushes main at the pre-prep sha so release metadata stays off main", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const repoRoot = yield* path.fromFileUrl(new URL("..", import.meta.url));
      const workflow = yield* fs.readFileString(
        path.join(repoRoot, ".github/workflows/sync-upstream.yml"),
      );

      assert.include(workflow, "scripts/ci/prepare-release-tag");
      assert.include(workflow, "steps.prepare.outputs.main_sha");
      assert.notInclude(
        workflow,
        "git push origin HEAD:main",
        "REGRESSION: pushing HEAD to main would carry the release-prep commit",
      );
    }),
  );

  it.effect("no longer stamps release versions inline in the workflow", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const repoRoot = yield* path.fromFileUrl(new URL("..", import.meta.url));
      const workflow = yield* fs.readFileString(
        path.join(repoRoot, ".github/workflows/sync-upstream.yml"),
      );

      assert.notInclude(
        workflow,
        "node scripts/update-release-package-versions.ts",
        "version stamping belongs in scripts/ci/prepare-release-tag",
      );
    }),
  );

  it.effect("prefers the self-hosted sync runner but falls back to GitHub-hosted", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const repoRoot = yield* path.fromFileUrl(new URL("..", import.meta.url));
      const workflow = yield* fs.readFileString(
        path.join(repoRoot, ".github/workflows/sync-upstream.yml"),
      );

      assert.include(workflow, "t3code-linux-sync");
      assert.include(
        workflow,
        "ubuntu-24.04",
        "REGRESSION: sync must still run when the self-hosted runner is offline",
      );
      assert.include(workflow, "SYNC_RERERE_CACHE");
      assert.include(
        workflow,
        "needs: runner",
        "REGRESSION: the sync job must declare needs: runner to read its outputs",
      );
      assert.include(
        workflow,
        "runs-on: ${{ fromJSON(needs.runner.outputs.labels) }}",
        "REGRESSION: sync must select its runner from the runner job's labels output via fromJSON",
      );
      assert.include(
        workflow,
        'echo "SYNC_RERERE_CACHE=$HOME/$RERERE_CACHE_SUFFIX" >> "$GITHUB_ENV"',
        "the self-hosted cache path must be resolved from $HOME on the machine that actually runs sync, not guessed by the ubuntu-24.04 probe job",
      );
      assert.notInclude(
        workflow,
        "/home/",
        "REGRESSION: the rerere cache path must not be hardcoded to a specific account; an unguarded mkdir -p on a mismatched account hard-fails the whole rebase step",
      );
    }),
  );

  it.effect("carries the retirement-rule guidance into the conflict-failure step", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const repoRoot = yield* path.fromFileUrl(new URL("..", import.meta.url));
      const workflow = yield* fs.readFileString(
        path.join(repoRoot, ".github/workflows/sync-upstream.yml"),
      );

      assert.include(
        workflow,
        "still needed at all",
        "REGRESSION: the conflict-failure step must surface the retire-then-narrow-then-adapt rule",
      );
    }),
  );
});
