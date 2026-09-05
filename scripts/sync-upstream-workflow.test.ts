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
      assert.include(rebaseDriver, 'stg_cmd reset --hard "$START_STACK"');
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

  it.effect("provisions Bun before every Bun-backed stack operation", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const repoRoot = yield* path.fromFileUrl(new URL("..", import.meta.url));
      const ciWorkflow = yield* fs.readFileString(path.join(repoRoot, ".github/workflows/ci.yml"));
      const releaseWorkflow = yield* fs.readFileString(
        path.join(repoRoot, ".github/workflows/release.yml"),
      );
      const testJob = ciWorkflow.slice(
        ciWorkflow.indexOf("  test:\n"),
        ciWorkflow.indexOf("  mobile_native_static_analysis:\n"),
      );
      const policyJob = ciWorkflow.slice(ciWorkflow.indexOf("  fork-policy:\n"));
      const releasePreflight = releaseWorkflow.slice(
        releaseWorkflow.indexOf("  preflight:\n"),
        releaseWorkflow.indexOf("  build:\n"),
      );
      const stackWriters = [
        yield* fs.readFileString(path.join(repoRoot, ".github/workflows/sync-upstream.yml")),
        yield* fs.readFileString(path.join(repoRoot, ".github/workflows/fork-push-nightly.yml")),
      ];

      for (const [name, workflow, operation] of [
        ["CI Test", testJob, "vp run --parallel"],
        ["CI Fork patch policy", policyJob, "scripts/ci/check-stgit-stack"],
        ["Release Preflight", releasePreflight, "vp run test"],
        ["Sync Upstream", stackWriters[0]!, "scripts/ci/reproduce-sync-upstream"],
        ["Fork Push Nightly", stackWriters[1]!, "scripts/ci/reproduce-sync-upstream"],
      ] as const) {
        assert.include(
          workflow,
          "oven-sh/setup-bun@v2",
          `REGRESSION: ${name} must install Bun before invoking Bun-backed stack tooling`,
        );
        assert.isBelow(
          workflow.indexOf("oven-sh/setup-bun@v2"),
          workflow.indexOf(operation),
          `${name} must install Bun before ${operation}`,
        );
      }
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
        assert.include(workflow, "STGIT_EXPECTED_REMOTE_MAIN:");
        assert.include(
          workflow,
          "STGIT_EXPECTED_REMOTE_MAIN: ${{ steps.pre.outputs.main_sha }}",
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
          "scripts/ci/record-main-lease",
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
      assert.include(syncWorkflow, "STGIT_BACKUP_NAMESPACE: bot");
      assert.include(nightlyWorkflow, "STGIT_BACKUP_NAMESPACE: bot");
      assert.include(syncWorkflow, 'new_tag="${UPSTREAM_TAG}-fork.${next_n}"');
      assert.include(syncWorkflow, 'new_tag="$UPSTREAM_TAG"');
      assert.include(nightlyWorkflow, 'new_tag="${upstream_tag}-fork.${next_n}"');
      assert.include(syncWorkflow, "scripts/ci/publish-stgit-stack --push");
      assert.include(syncWorkflow, 'STGIT_RELEASE_TAG="$NEW_TAG"');
      assert.include(nightlyWorkflow, "scripts/ci/publish-stgit-stack --push");
      assert.include(nightlyWorkflow, 'STGIT_RELEASE_TAG="$NEW_TAG"');
      assert.include(releaseWorkflow, "push:\n    tags:");
    }),
  );

  it.effect("validates the unstamped candidate before either automatic publication", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const repoRoot = yield* path.fromFileUrl(new URL("..", import.meta.url));
      for (const name of ["sync-upstream.yml", "fork-push-nightly.yml"]) {
        const workflow = yield* fs.readFileString(path.join(repoRoot, ".github/workflows", name));
        const prepare = workflow.indexOf("scripts/ci/prepare-stgit-publication");
        const replay = workflow.indexOf("run: scripts/ci/reproduce-sync-upstream");
        const gate = workflow.indexOf("scripts/ci/verify-stgit-replay");
        const stamp = workflow.indexOf("scripts/ci/prepare-release-tag");
        const publish = workflow.indexOf("scripts/ci/publish-stgit-stack --push");
        assert.isAtLeast(prepare, 0);
        assert.isBelow(prepare, replay);
        assert.isBelow(replay, gate);
        assert.isBelow(gate, stamp);
        assert.isBelow(stamp, publish);
        assert.notInclude(workflow, "scripts/ci/refresh-stgit-metadata");
        assert.notInclude(workflow, "git push --atomic");
      }
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

  it.effect("emits a versioned autonomous-repair handoff without coupling channels", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const repoRoot = yield* path.fromFileUrl(new URL("..", import.meta.url));
      const workflow = yield* fs.readFileString(
        path.join(repoRoot, ".github/workflows/sync-upstream.yml"),
      );

      assert.include(workflow, 'marker:"t3code.sync-upstream-repair"');
      assert.include(workflow, "repairEligible:true");
      assert.include(workflow, "upstreamTarget:$target");
      assert.include(workflow, "channel:$channel");
      assert.include(workflow, "failingPatch:$patch");
      assert.include(workflow, "conflictingFiles:");
      assert.include(workflow, 'requiredStackContext:"t3code.stgit-stack-context/v1"');
      assert.include(workflow, "claimWithinMinutes:20");
      assert.include(workflow, "CI_REPAIR_BOT_HANDOFF=");
      assert.include(workflow, '>> "$GITHUB_STEP_SUMMARY"');
      assert.include(workflow, "fail-fast: false");
      assert.include(
        workflow,
        "A conflict in one matrix channel does not block or invalidate the other channel.",
      );
    }),
  );

  it.effect("routes fork push conflicts through the eligible repair workflow", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const repoRoot = yield* path.fromFileUrl(new URL("..", import.meta.url));
      const workflow = yield* fs.readFileString(
        path.join(repoRoot, ".github/workflows/fork-push-nightly.yml"),
      );

      assert.include(workflow, "CI_REPAIR_BOT_CONFLICT_MODE: output");
      assert.include(workflow, "steps.replay.outputs.status == 'conflict'");
      assert.include(workflow, "gh workflow run sync-upstream.yml");
      assert.include(workflow, "--ref main");
      assert.include(workflow, "-f channel=nightly");
      assert.isBelow(
        workflow.indexOf("scripts/ci/reproduce-sync-upstream"),
        workflow.indexOf("gh workflow run sync-upstream.yml"),
        "the push-nightly replay must detect a conflict before dispatching repair",
      );
    }),
  );
});
