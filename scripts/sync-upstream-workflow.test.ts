import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
// @effect-diagnostics-next-line nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
// @effect-diagnostics-next-line nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
// @effect-diagnostics-next-line nodeBuiltinImport:off
import * as NodePath from "node:path";
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

  it.effect("collapses the fork delta to one replay commit on every target", () =>
    Effect.sync(() => {
      const fixtureRoot = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-sync-upstream-"));
      const upstreamRoot = NodePath.join(fixtureRoot, "upstream");
      const forkRoot = NodePath.join(fixtureRoot, "fork");
      const repoRoot = new URL("..", import.meta.url).pathname;
      const gitPath = NodeChildProcess.execFileSync("which", ["git"], { encoding: "utf8" }).trim();

      const git = (cwd: string, ...args: Array<string>) =>
        NodeChildProcess.execFileSync(gitPath, args, { cwd, encoding: "utf8" }).trim();

      try {
        NodeFS.mkdirSync(upstreamRoot);
        git(upstreamRoot, "init", "-b", "main");
        git(upstreamRoot, "config", "user.name", "Sync Test");
        git(upstreamRoot, "config", "user.email", "sync-test@example.invalid");
        NodeFS.writeFileSync(NodePath.join(upstreamRoot, "upstream-owned.txt"), "upstream=base\n");
        NodeFS.writeFileSync(NodePath.join(upstreamRoot, "fork-owned.txt"), "fork=base\n");
        git(upstreamRoot, "add", ".");
        git(upstreamRoot, "commit", "-m", "upstream base");

        NodeChildProcess.execFileSync(gitPath, ["clone", upstreamRoot, forkRoot], {
          encoding: "utf8",
        });
        git(forkRoot, "config", "user.name", "Sync Test");
        git(forkRoot, "config", "user.email", "sync-test@example.invalid");
        NodeFS.mkdirSync(NodePath.join(forkRoot, "scripts", "ci"), { recursive: true });
        NodeFS.cpSync(
          NodePath.join(repoRoot, "scripts", "ci", "reproduce-sync-upstream"),
          NodePath.join(forkRoot, "scripts", "ci", "reproduce-sync-upstream"),
        );
        NodeFS.chmodSync(
          NodePath.join(forkRoot, "scripts", "ci", "reproduce-sync-upstream"),
          0o755,
        );
        NodeFS.writeFileSync(NodePath.join(forkRoot, "fork-owned.txt"), "fork=custom\n");
        NodeFS.writeFileSync(NodePath.join(forkRoot, "fork-only.txt"), "preserved\n");
        git(forkRoot, "add", ".");
        git(forkRoot, "commit", "-m", "fork patch one");
        NodeFS.writeFileSync(NodePath.join(forkRoot, "fork-two.txt"), "also preserved\n");
        git(forkRoot, "add", ".");
        git(forkRoot, "commit", "-m", "fork patch two");

        const runSync = (target: string) =>
          NodeChildProcess.execFileSync(
            NodePath.join(forkRoot, "scripts", "ci", "reproduce-sync-upstream"),
            {
              cwd: forkRoot,
              encoding: "utf8",
              env: {
                ...process.env,
                CI_REPAIR_BOT_GIT_BIN: gitPath,
                CI_REPAIR_BOT_UPSTREAM_REMOTE: "origin",
                CI_REPAIR_BOT_UPSTREAM_SOURCE_REF: `refs/tags/${target}`,
                CI_REPAIR_BOT_UPSTREAM_TARGET: `refs/tags/upstream/${target}`,
              },
            },
          );

        NodeFS.writeFileSync(NodePath.join(upstreamRoot, "upstream-owned.txt"), "upstream=one\n");
        git(upstreamRoot, "add", "upstream-owned.txt");
        git(upstreamRoot, "commit", "-m", "upstream target one");
        git(upstreamRoot, "tag", "target-1");

        runSync("target-1");
        assert.strictEqual(git(forkRoot, "rev-list", "--count", "upstream/target-1..HEAD"), "1");
        assert.strictEqual(
          NodeFS.readFileSync(NodePath.join(forkRoot, "upstream-owned.txt"), "utf8"),
          "upstream=one\n",
        );
        assert.strictEqual(
          NodeFS.readFileSync(NodePath.join(forkRoot, "fork-owned.txt"), "utf8"),
          "fork=custom\n",
        );

        NodeFS.writeFileSync(
          NodePath.join(upstreamRoot, "upstream-two.txt"),
          "new upstream file\n",
        );
        git(upstreamRoot, "add", ".");
        git(upstreamRoot, "commit", "-m", "upstream target two");
        git(upstreamRoot, "tag", "target-2");

        runSync("target-2");
        assert.strictEqual(git(forkRoot, "rev-list", "--count", "upstream/target-2..HEAD"), "1");
        assert.strictEqual(
          NodeFS.readFileSync(NodePath.join(forkRoot, "fork-only.txt"), "utf8"),
          "preserved\n",
        );
        assert.strictEqual(
          NodeFS.readFileSync(NodePath.join(forkRoot, "fork-two.txt"), "utf8"),
          "also preserved\n",
        );
        assert.strictEqual(
          NodeFS.readFileSync(NodePath.join(forkRoot, "upstream-two.txt"), "utf8"),
          "new upstream file\n",
        );
      } finally {
        NodeFS.rmSync(fixtureRoot, { recursive: true, force: true });
      }
    }),
  );
});
