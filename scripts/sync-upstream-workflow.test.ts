import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { test } from "vitest";

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

test("sync-upstream collapses the fork delta to one replay commit on every target", () => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "t3-sync-upstream-"));
  const upstreamRoot = join(fixtureRoot, "upstream");
  const forkRoot = join(fixtureRoot, "fork");
  const repoRoot = new URL("..", import.meta.url).pathname;
  const gitPath = execFileSync("which", ["git"], { encoding: "utf8" }).trim();

  const git = (cwd: string, ...args: Array<string>) =>
    execFileSync(gitPath, args, { cwd, encoding: "utf8" }).trim();

  try {
    mkdirSync(upstreamRoot);
    git(upstreamRoot, "init", "-b", "main");
    git(upstreamRoot, "config", "user.name", "Sync Test");
    git(upstreamRoot, "config", "user.email", "sync-test@example.invalid");
    writeFileSync(join(upstreamRoot, "shared.txt"), "upstream=base\nfork=base\n");
    git(upstreamRoot, "add", "shared.txt");
    git(upstreamRoot, "commit", "-m", "upstream base");

    execFileSync(gitPath, ["clone", upstreamRoot, forkRoot], { encoding: "utf8" });
    git(forkRoot, "config", "user.name", "Sync Test");
    git(forkRoot, "config", "user.email", "sync-test@example.invalid");
    mkdirSync(join(forkRoot, "scripts", "ci"), { recursive: true });
    cpSync(
      join(repoRoot, "scripts", "ci", "reproduce-sync-upstream"),
      join(forkRoot, "scripts", "ci", "reproduce-sync-upstream"),
    );
    chmodSync(join(forkRoot, "scripts", "ci", "reproduce-sync-upstream"), 0o755);
    writeFileSync(join(forkRoot, "shared.txt"), "upstream=base\nfork=custom\n");
    writeFileSync(join(forkRoot, "fork-only.txt"), "preserved\n");
    git(forkRoot, "add", ".");
    git(forkRoot, "commit", "-m", "fork patch one");
    writeFileSync(join(forkRoot, "fork-two.txt"), "also preserved\n");
    git(forkRoot, "add", ".");
    git(forkRoot, "commit", "-m", "fork patch two");

    const runSync = (target: string) =>
      execFileSync(join(forkRoot, "scripts", "ci", "reproduce-sync-upstream"), {
        cwd: forkRoot,
        encoding: "utf8",
        env: {
          ...process.env,
          CI_REPAIR_BOT_GIT_BIN: gitPath,
          CI_REPAIR_BOT_UPSTREAM_REMOTE: "origin",
          CI_REPAIR_BOT_UPSTREAM_SOURCE_REF: `refs/tags/${target}`,
          CI_REPAIR_BOT_UPSTREAM_TARGET: `refs/tags/upstream/${target}`,
        },
      });

    writeFileSync(join(upstreamRoot, "shared.txt"), "upstream=one\nfork=base\n");
    git(upstreamRoot, "add", "shared.txt");
    git(upstreamRoot, "commit", "-m", "upstream target one");
    git(upstreamRoot, "tag", "target-1");

    runSync("target-1");
    assert.strictEqual(git(forkRoot, "rev-list", "--count", "upstream/target-1..HEAD"), "1");
    assert.strictEqual(
      readFileSync(join(forkRoot, "shared.txt"), "utf8"),
      "upstream=one\nfork=custom\n",
    );

    writeFileSync(join(upstreamRoot, "upstream-two.txt"), "new upstream file\n");
    git(upstreamRoot, "add", ".");
    git(upstreamRoot, "commit", "-m", "upstream target two");
    git(upstreamRoot, "tag", "target-2");

    runSync("target-2");
    assert.strictEqual(git(forkRoot, "rev-list", "--count", "upstream/target-2..HEAD"), "1");
    assert.strictEqual(readFileSync(join(forkRoot, "fork-only.txt"), "utf8"), "preserved\n");
    assert.strictEqual(readFileSync(join(forkRoot, "fork-two.txt"), "utf8"), "also preserved\n");
    assert.strictEqual(readFileSync(join(forkRoot, "upstream-two.txt"), "utf8"), "new upstream file\n");
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});
