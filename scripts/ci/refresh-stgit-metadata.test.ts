// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { assert, describe, it } from "@effect/vitest";
import { createFixtureRepo } from "./lib/git-fixture.ts";

const repoRoot = NodePath.resolve(
  NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
  "../..",
);
const script = NodePath.join(repoRoot, "scripts/ci/refresh-stgit-metadata");

const run = (
  repoDir: string,
  env: Record<string, string>,
): NodeChildProcess.SpawnSyncReturns<string> =>
  NodeChildProcess.spawnSync(script, [], {
    cwd: repoDir,
    encoding: "utf8",
    env: { ...process.env, ...env, SYNC_GIT_BIN: "/usr/bin/git" },
  });

const writeStack = (
  repoDir: string,
  stackRef: string,
  head: string,
  patches: Record<string, string>,
) => {
  const payload = JSON.stringify({
    version: 5,
    prev: head,
    head,
    applied: Object.keys(patches),
    unapplied: [],
    hidden: [],
    patches: Object.fromEntries(Object.entries(patches).map(([name, oid]) => [name, { oid }])),
  });
  const blob = NodeChildProcess.execFileSync("/usr/bin/git", ["hash-object", "-w", "--stdin"], {
    cwd: repoDir,
    input: payload,
    encoding: "utf8",
  }).trim();
  const tree = NodeChildProcess.execFileSync("/usr/bin/git", ["mktree"], {
    cwd: repoDir,
    input: `100644 blob ${blob}\tstack.json\n`,
    encoding: "utf8",
  }).trim();
  const commit = NodeChildProcess.execFileSync("/usr/bin/git", ["commit-tree", tree, "-p", head], {
    cwd: repoDir,
    input: "stg stack\n",
    encoding: "utf8",
  }).trim();
  NodeChildProcess.execFileSync("/usr/bin/git", ["update-ref", stackRef, commit], { cwd: repoDir });
};

describe("refresh-stgit-metadata", () => {
  it("REGRESSION: updates stack.json.head and every curated patch ref to the replayed main commits", () => {
    const repo = createFixtureRepo();
    try {
      const previousMain = repo.git("rev-parse", "HEAD");
      const previousPatches: Record<string, string> = {};
      for (const [name, subject] of [
        ["fork-build-and-release-tooling", "fork: build and release tooling"],
        ["fork-ci-release-and-sync", "fork(ci): release and sync pipeline"],
      ]) {
        repo.writeFile(`${name}.txt`, "old\n");
        previousPatches[name] = repo.commitAll(subject);
        repo.git("update-ref", `refs/patches/stgit/adopt/${name}`, previousPatches[name]);
      }
      const oldMain = repo.git("rev-parse", "HEAD");
      writeStack(repo.dir, "refs/stacks/stgit/adopt", oldMain, previousPatches);

      repo.git("reset", "--hard", previousMain);
      const replayedPatches: Record<string, string> = {};
      for (const [name, subject] of [
        ["fork-build-and-release-tooling", "fork: build and release tooling"],
        ["fork-ci-release-and-sync", "fork(ci): release and sync pipeline"],
      ]) {
        repo.writeFile(`${name}.txt`, "replayed\n");
        replayedPatches[name] = repo.commitAll(subject);
      }
      const mainSha = repo.git("rev-parse", "HEAD");

      const result = run(repo.dir, {
        STGIT_BRANCH: "adopt",
        STGIT_EXPECTED_HEAD: oldMain,
        STGIT_MAIN_SHA: mainSha,
      });
      assert.strictEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);

      const stack = JSON.parse(repo.git("show", "refs/stacks/stgit/adopt:stack.json")) as {
        head: string;
        patches: Record<string, { oid: string }>;
      };
      assert.strictEqual(stack.head, mainSha, "REGRESSION: stack.json.head must equal main");
      for (const [name, sha] of Object.entries(replayedPatches)) {
        assert.strictEqual(stack.patches[name]?.oid, sha);
        assert.strictEqual(repo.git("rev-parse", `refs/patches/stgit/adopt/${name}`), sha);
        assert.include(
          repo.git("show", `refs/stacks/stgit/adopt:patches/${name}`),
          `Top:    ${sha}`,
          "patch metadata must follow the replayed commit too",
        );
      }
    } finally {
      repo.cleanup();
    }
  });

  it("refuses to overwrite StGit metadata whose recorded head no longer matches the main lease", () => {
    const repo = createFixtureRepo();
    try {
      const mainSha = repo.git("rev-parse", "HEAD");
      writeStack(repo.dir, "refs/stacks/stgit/adopt", mainSha, {});
      const result = run(repo.dir, {
        STGIT_BRANCH: "adopt",
        STGIT_EXPECTED_HEAD: "0000000000000000000000000000000000000000",
        STGIT_MAIN_SHA: mainSha,
      });
      assert.notStrictEqual(result.status, 0);
      assert.include(`${result.stdout}\n${result.stderr}`, "does not match expected main lease");
    } finally {
      repo.cleanup();
    }
  });
});
