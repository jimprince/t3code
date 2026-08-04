// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import { assert, describe, it } from "@effect/vitest";
import { createFixtureRepo } from "./lib/git-fixture.ts";

describe("git fixture", () => {
  it("creates a repo with one commit on main", () => {
    const repo = createFixtureRepo();
    try {
      assert.strictEqual(repo.git("rev-parse", "--abbrev-ref", "HEAD"), "main");
      assert.strictEqual(repo.git("rev-list", "--count", "HEAD"), "1");
    } finally {
      repo.cleanup();
    }
  });

  it("commitAll returns the sha of the new commit", () => {
    const repo = createFixtureRepo();
    try {
      repo.writeFile("a.txt", "hello");
      const sha = repo.commitAll("feat: add a");
      assert.strictEqual(sha, repo.git("rev-parse", "HEAD"));
      assert.strictEqual(repo.git("rev-list", "--count", "HEAD"), "2");
    } finally {
      repo.cleanup();
    }
  });

  it("git() throws on a failing command", () => {
    const repo = createFixtureRepo();
    try {
      assert.throws(() => repo.git("rev-parse", "definitely-not-a-ref"));
    } finally {
      repo.cleanup();
    }
  });

  it("cleanup removes the directory", () => {
    const repo = createFixtureRepo();
    const dir = repo.dir;
    repo.cleanup();
    assert.isFalse(NodeFS.existsSync(dir));
  });
});
