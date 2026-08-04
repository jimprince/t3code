import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

it.layer(NodeServices.layer)("sync-upstream workflow", (it) => {
  it.effect("replays the published StGit series", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const repoRoot = yield* path.fromFileUrl(new URL("..", import.meta.url));
      const rebaseDriver = yield* fs.readFileString(
        path.join(repoRoot, "scripts/ci/reproduce-sync-upstream"),
      );

      assert.include(rebaseDriver, "refs/stacks/stgit/adopt");
      assert.include(rebaseDriver, "refs/patches/stgit/adopt/*");
      assert.include(rebaseDriver, 'stg_cmd rebase --merged "$CI_REPAIR_BOT_UPSTREAM_TARGET"');
      assert.include(rebaseDriver, "failing patch:");
    }),
  );

  it.effect("requires current metadata before mutating the checkout", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const repoRoot = yield* path.fromFileUrl(new URL("..", import.meta.url));
      const rebaseDriver = yield* fs.readFileString(
        path.join(repoRoot, "scripts/ci/reproduce-sync-upstream"),
      );

      assert.include(rebaseDriver, "recorded_head");
      assert.include(rebaseDriver, '"$recorded_head" != "$START_HEAD"');
      assert.include(rebaseDriver, "do not initialize a replacement stack");
      assert.include(rebaseDriver, "stg_cmd undo --hard");
    }),
  );

  it.effect("installs the pinned StGit release before sync", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const repoRoot = yield* path.fromFileUrl(new URL("..", import.meta.url));
      const workflow = yield* fs.readFileString(
        path.join(repoRoot, ".github/workflows/sync-upstream.yml"),
      );

      assert.include(workflow, "scripts/ci/install-stgit");
      assert.include(workflow, "scripts/ci/reproduce-sync-upstream");
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

  it.effect("keeps release preparation off main in both automatic taggers", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const repoRoot = yield* path.fromFileUrl(new URL("..", import.meta.url));
      const workflows = [
        yield* fs.readFileString(path.join(repoRoot, ".github/workflows/sync-upstream.yml")),
        yield* fs.readFileString(path.join(repoRoot, ".github/workflows/fork-push-nightly.yml")),
      ];

      for (const workflow of workflows) {
        assert.include(workflow, "scripts/ci/prepare-release-tag");
        assert.include(workflow, "steps.prepare.outputs.main_sha");
        assert.include(workflow, "steps.prepare.outputs.prep_sha");
        assert.include(workflow, "steps.prepare.outputs.tag");
        assert.include(workflow, 'tag_sha="$(git rev-parse "${NEW_TAG}^{commit}")"');
        assert.include(workflow, '"$(git rev-parse "${PREP_SHA}^")" != "$MAIN_SHA"');
        assert.notInclude(
          workflow,
          "git push origin HEAD:main",
          "REGRESSION: automatic taggers must push the pre-stamp SHA, never the prep commit",
        );
        assert.notInclude(
          workflow,
          "node scripts/update-release-package-versions.ts",
          "version stamping belongs in scripts/ci/prepare-release-tag",
        );
      }
    }),
  );

  it.effect("pins both main rewrites to the exact main SHA observed before preparation", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const repoRoot = yield* path.fromFileUrl(new URL("..", import.meta.url));

      for (const workflowName of ["sync-upstream.yml", "fork-push-nightly.yml"]) {
        const workflow = yield* fs.readFileString(
          path.join(repoRoot, ".github/workflows", workflowName),
        );
        assert.include(workflow, "LEASE_SHA:");
        assert.include(
          workflow,
          "--force-with-lease=refs/heads/main:${LEASE_SHA}",
          `REGRESSION: ${workflowName} must reject a stale main lease`,
        );
        assert.notInclude(
          workflow,
          "git push origin HEAD:main --force-with-lease",
          `REGRESSION: ${workflowName} must not use a fetch-renewable implicit lease`,
        );
        assert.isBelow(
          workflow.indexOf("- name: Record main lease"),
          workflow.indexOf("- name: Prepare release tag"),
          `${workflowName} must pin main before release preparation can fetch or rewrite refs`,
        );
      }
    }),
  );

  it.effect("rejects stale queued checkouts in both automatic main writers", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const repoRoot = yield* path.fromFileUrl(new URL("..", import.meta.url));

      for (const workflowName of ["sync-upstream.yml", "fork-push-nightly.yml"]) {
        const workflow = yield* fs.readFileString(
          path.join(repoRoot, ".github/workflows", workflowName),
        );
        assert.include(
          workflow,
          "run: scripts/ci/record-main-lease",
          `REGRESSION: ${workflowName} must compare checked-out HEAD with remote main before replay`,
        );
      }
    }),
  );

  it.effect("does not let Release finalize write generated metadata back to main", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const repoRoot = yield* path.fromFileUrl(new URL("..", import.meta.url));
      const workflow = yield* fs.readFileString(
        path.join(repoRoot, ".github/workflows/release.yml"),
      );

      assert.notMatch(
        workflow,
        /\n  finalize:\n/,
        "Release must end at publication; a finalize job can re-inject release stamps into main",
      );
      assert.notMatch(
        workflow,
        /git push[^\n]*(?:HEAD:main|refs\/heads\/main)/,
        "REGRESSION: release.yml must never push main",
      );
    }),
  );

  it.effect("shares the main-writer lock and preserves tag-triggered Release", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const repoRoot = yield* path.fromFileUrl(new URL("..", import.meta.url));
      const syncWorkflow = yield* fs.readFileString(
        path.join(repoRoot, ".github/workflows/sync-upstream.yml"),
      );
      const nightlyWorkflow = yield* fs.readFileString(
        path.join(repoRoot, ".github/workflows/fork-push-nightly.yml"),
      );
      const releaseWorkflow = yield* fs.readFileString(
        path.join(repoRoot, ".github/workflows/release.yml"),
      );

      assert.include(syncWorkflow, "group: t3code-writes-main");
      assert.include(nightlyWorkflow, "group: t3code-writes-main");
      assert.include(syncWorkflow, "refs/heads/backup/auto/sync-");
      assert.include(nightlyWorkflow, "refs/heads/backup/auto/nightly-");
      assert.include(syncWorkflow, 'new_tag="${UPSTREAM_TAG}-fork.${next_n}"');
      assert.include(syncWorkflow, 'new_tag="$UPSTREAM_TAG"');
      assert.include(nightlyWorkflow, 'new_tag="${upstream_tag}-fork.${next_n}"');
      assert.include(syncWorkflow, "git push --atomic origin");
      assert.include(syncWorkflow, '"refs/tags/${NEW_TAG}:refs/tags/${NEW_TAG}"');
      assert.include(nightlyWorkflow, "git push --atomic origin");
      assert.include(nightlyWorkflow, '"refs/tags/${NEW_TAG}:refs/tags/${NEW_TAG}"');
      assert.include(releaseWorkflow, "push:\n    tags:");
    }),
  );

  it.effect("recognizes a release-prep tag on a direct child of main", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const repoRoot = yield* path.fromFileUrl(new URL("..", import.meta.url));
      const workflow = yield* fs.readFileString(
        path.join(repoRoot, ".github/workflows/fork-push-nightly.yml"),
      );

      assert.include(
        workflow,
        '"${tag}^{commit}^"',
        "REGRESSION: a Sync tag now points to main's stamped child, so checking only tags at HEAD double-publishes the same main rewrite",
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
