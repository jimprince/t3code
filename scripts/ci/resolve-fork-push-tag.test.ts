// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { assert, describe, it } from "vite-plus/test";
import { createFixtureRepo, type FixtureRepo } from "./lib/git-fixture.ts";

const script = NodePath.resolve(import.meta.dirname, "resolve-fork-push-tag");

function run(repo: FixtureRepo, stackBase?: string, upstreamUrl = repo.dir, expectedTag = "") {
  const output = NodePath.join(
    NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-fork-tag-output-")),
    "output",
  );
  const args = [...(stackBase ? ["--stack-base", stackBase] : []), "--upstream-url", upstreamUrl];
  const result = NodeChildProcess.spawnSync(script, args, {
    cwd: repo.dir,
    encoding: "utf8",
    env: {
      ...process.env,
      GITHUB_OUTPUT: output,
      EXPECTED_UPSTREAM_TAG: expectedTag,
      PATH: `/usr/bin:/bin:${process.env.PATH}`,
    },
  });
  const values = Object.fromEntries(
    (NodeFS.existsSync(output) ? NodeFS.readFileSync(output, "utf8") : "")
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const separator = line.indexOf("=");
        return [line.slice(0, separator), line.slice(separator + 1)];
      }),
  );
  NodeFS.rmSync(NodePath.dirname(output), { recursive: true, force: true });
  return { ...result, values };
}

function addCommit(repo: FixtureRepo, value: string): string {
  repo.writeFile("value", `${value}\n`);
  return repo.commitAll(value);
}

describe("fork-push release tag selection", () => {
  it("rejects a pinned target mismatch and accepts the exact integrated target", () => {
    const repo = createFixtureRepo();
    try {
      const base = repo.git("rev-parse", "HEAD");
      const tag = "v1.2.3-nightly.20260920.2005";
      repo.git("tag", tag, base);
      addCommit(repo, "fork repair");
      const bad = run(repo, base, repo.dir, "v1.2.3-nightly.20260919.1895");
      assert.notEqual(bad.status, 0);
      assert.include(bad.stderr, "does not match the pinned upstream target");
      assert.deepEqual(bad.values, {});
      const good = run(repo, base, repo.dir, tag);
      assert.equal(good.status, 0, good.stderr);
      assert.equal(good.values.tag, `${tag}-fork.1`);
    } finally {
      repo.cleanup();
    }
  });

  it("keeps the integrated nightly when a newer upstream nightly exists and increments its suffix", () => {
    const repo = createFixtureRepo();
    try {
      const base = repo.git("rev-parse", "HEAD");
      repo.git("tag", "v1.2.3-nightly.20260918.1895", base);
      repo.git("tag", "v1.2.3-nightly.20260918.1895-fork.1", base);
      repo.git("tag", "v1.2.3-nightly.20260918.1895-fork.3", base);
      addCommit(repo, "fork feature");

      repo.git("checkout", "-q", "-b", "upstream-new", base);
      const newer = addCommit(repo, "newer upstream");
      repo.git("tag", "v1.2.3-nightly.20260919.1896", newer);
      repo.git("checkout", "-q", "main");

      const result = run(repo, base);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.values.needed, "true");
      assert.equal(result.values.upstream_tag, "v1.2.3-nightly.20260918.1895");
      assert.equal(result.values.tag, "v1.2.3-nightly.20260918.1895-fork.4");
      assert.notInclude(result.stdout, "1896");
    } finally {
      repo.cleanup();
    }
  });

  it("fails safely when the stack base has no matching upstream nightly", () => {
    const repo = createFixtureRepo();
    try {
      const base = repo.git("rev-parse", "HEAD");
      addCommit(repo, "fork feature");
      const result = run(repo, base);
      assert.notEqual(result.status, 0);
      assert.include(result.stderr, "does not resolve to one upstream nightly tag");
      assert.deepEqual(result.values, {});
    } finally {
      repo.cleanup();
    }
  });

  it("fails safely when more than one nightly tag names the stack base", () => {
    const repo = createFixtureRepo();
    try {
      const base = repo.git("rev-parse", "HEAD");
      repo.git("tag", "v1.2.3-nightly.20260918.1895", base);
      repo.git("tag", "v1.2.3-nightly.20260918.1896", base);
      addCommit(repo, "fork feature");
      const result = run(repo, base);
      assert.notEqual(result.status, 0);
      assert.include(result.stderr, "resolves to multiple upstream nightly tags");
      assert.deepEqual(result.values, {});
    } finally {
      repo.cleanup();
    }
  });

  it("skips a stable stack base instead of inventing a nightly source", () => {
    const repo = createFixtureRepo();
    try {
      const base = repo.git("rev-parse", "HEAD");
      repo.git("tag", "v1.2.3", base);
      addCommit(repo, "fork feature");
      const result = run(repo, base);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.values.needed, "false");
      assert.equal(result.values.reason, "stable-base");
      assert.include(result.stdout, "fork-push nightly is not applicable");
    } finally {
      repo.cleanup();
    }
  });

  it("skips source that already has a release tag without consulting upstream", () => {
    const repo = createFixtureRepo();
    try {
      repo.git("tag", "v1.2.3-nightly.20260918.1895-fork.1");
      const result = run(repo, undefined, "/definitely/not/an/upstream/repository");
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.values.needed, "false");
      assert.equal(result.values.reason, "already-released");
    } finally {
      repo.cleanup();
    }
  });
});
