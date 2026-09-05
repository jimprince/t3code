// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { assert, describe, it } from "vite-plus/test";
import { createFixtureRepo, type FixtureRepo } from "./lib/git-fixture.ts";

const script = NodePath.resolve(import.meta.dirname, "check-nightly-push");
function needed(repo: FixtureRepo, before: string, event = "push") {
  const output = NodePath.join(repo.dir, "output");
  NodeFS.writeFileSync(output, "");
  NodeChildProcess.execFileSync(script, [], {
    cwd: repo.dir,
    stdio: "pipe",
    env: {
      ...process.env,
      PATH: `/usr/bin:/bin:${process.env.PATH}`,
      GITHUB_EVENT_NAME: event,
      PUSH_BEFORE: before,
      PUSH_AFTER: repo.git("rev-parse", "HEAD"),
      GITHUB_OUTPUT: output,
    },
  });
  return NodeFS.readFileSync(output, "utf8").trim();
}

describe("nightly push tree filter", () => {
  it("skips a history rewrite with identical packaged source", () => {
    const repo = createFixtureRepo();
    try {
      repo.writeFile("apps/server/source.ts", "export const value = 1;\n");
      const before = repo.commitAll("runtime");
      repo.git("checkout", "--orphan", "rewritten");
      repo.writeFile(".github/workflows/release.yml", "name: Maintenance\n");
      repo.commitAll("re-rendered history");
      assert.equal(needed(repo, before), "needed=false");
    } finally {
      repo.cleanup();
    }
  });

  for (const path of [
    "apps/server/source.ts",
    "apps/web/source.ts",
    "apps/desktop/source.ts",
    "packages/contracts/source.ts",
    "assets/icon.png",
    "package.json",
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
    "scripts/build-desktop-artifact.ts",
    "scripts/build-headless-artifact.ts",
    "scripts/lib/brand-assets.ts",
  ]) {
    it(`releases a change to ${path}`, () => {
      const repo = createFixtureRepo();
      try {
        const before = repo.git("rev-parse", "HEAD");
        repo.writeFile(path, "changed\n");
        repo.commitAll("runtime change");
        assert.equal(needed(repo, before), "needed=true");
      } finally {
        repo.cleanup();
      }
    });
  }

  it("releases deletions and renames out of packaged paths", () => {
    const repo = createFixtureRepo();
    try {
      repo.writeFile("apps/server/source.ts", "runtime\n");
      const before = repo.commitAll("runtime");
      repo.git("mv", "apps/server/source.ts", "removed-source.ts");
      repo.commitAll("remove runtime file");
      assert.equal(needed(repo, before), "needed=true");
    } finally {
      repo.cleanup();
    }
  });

  it("keeps manual and unknown-history releases available", () => {
    const repo = createFixtureRepo();
    try {
      const head = repo.git("rev-parse", "HEAD");
      assert.equal(needed(repo, head), "needed=false");
      assert.equal(needed(repo, head, "workflow_dispatch"), "needed=true");
      assert.equal(needed(repo, "0".repeat(40)), "needed=true");
      assert.equal(needed(repo, "a".repeat(40)), "needed=true");
    } finally {
      repo.cleanup();
    }
  });
});
