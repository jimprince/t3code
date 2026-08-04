// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { assert, describe, it } from "@effect/vitest";
import { createFixtureRepo, type FixtureRepo } from "./lib/git-fixture.ts";

const repoRoot = NodePath.resolve(
  NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
  "../..",
);
const script = NodePath.join(repoRoot, "scripts/ci/publish-stgit-stack");

const gitAt = (dir: string, ...args: readonly string[]): string =>
  NodeChildProcess.execFileSync("/usr/bin/git", [...args], {
    cwd: dir,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();

const seedPublication = (): {
  readonly repo: FixtureRepo;
  readonly remote: string;
  readonly head: string;
  readonly obsoleteRef: string;
} => {
  const repo = createFixtureRepo();
  repo.writeFile("scripts/ci/check-stgit-stack", "#!/usr/bin/env bash\nexit 0\n");
  repo.writeFile("scripts/ci/check-fork-docs.ts", "process.exit(0);\n");
  NodeFS.chmodSync(NodePath.join(repo.dir, "scripts/ci/check-stgit-stack"), 0o755);
  repo.git("add", "scripts/ci/check-stgit-stack", "scripts/ci/check-fork-docs.ts");
  repo.git("update-index", "--chmod=+x", "scripts/ci/check-stgit-stack");
  repo.git("commit", "-m", "test: add policy stubs");
  const remoteBase = repo.git("rev-parse", "HEAD");
  repo.git("switch", "-c", "stgit/adopt");

  const remote = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-stgit-remote-"));
  gitAt(remote, "init", "--bare");
  repo.git("remote", "add", "origin", remote);
  repo.git("push", "-u", "origin", `${remoteBase}:refs/heads/main`);

  const patches: [string, string][] = [];
  for (const [name, subject] of [
    ["fork-policy", "docs(fork): policy"],
    ["fork-feature", "feat(fork): feature"],
  ] as const) {
    repo.writeFile(`${name}.txt`, `${name}\n`);
    patches.push([name, repo.commitAll(subject)]);
  }
  const head = repo.git("rev-parse", "HEAD");
  const stack = JSON.stringify({
    version: 5,
    prev: remoteBase,
    head,
    applied: patches.map(([name]) => name),
    unapplied: [],
    hidden: [],
    patches: Object.fromEntries(patches.map(([name, oid]) => [name, { oid }])),
  });
  const blob = NodeChildProcess.execFileSync("/usr/bin/git", ["hash-object", "-w", "--stdin"], {
    cwd: repo.dir,
    input: stack,
    encoding: "utf8",
  }).trim();
  const tree = NodeChildProcess.execFileSync("/usr/bin/git", ["mktree"], {
    cwd: repo.dir,
    input: `100644 blob ${blob}\tstack.json\n`,
    encoding: "utf8",
  }).trim();
  const stackOid = repo.git("commit-tree", tree, "-p", head);
  const stackRef = "refs/stacks/stgit/adopt";
  repo.git("update-ref", stackRef, stackOid);
  for (const [name, oid] of patches)
    repo.git("update-ref", `refs/patches/stgit/adopt/${name}`, oid);
  const obsoleteRef = "refs/patches/stgit/adopt/fork-retired";
  repo.git("update-ref", obsoleteRef, remoteBase);
  repo.git(
    "push",
    "origin",
    `${stackRef}:${stackRef}`,
    ...patches.map(([name]) => `refs/patches/stgit/adopt/${name}:refs/patches/stgit/adopt/${name}`),
    `${obsoleteRef}:${obsoleteRef}`,
  );
  return { repo, remote, head, obsoleteRef };
};

const run = (repo: FixtureRepo, mode: "--check" | "--push") =>
  NodeChildProcess.spawnSync(script, [mode], {
    cwd: repo.dir,
    encoding: "utf8",
    env: { ...process.env, SYNC_GIT_BIN: "/usr/bin/git" },
  });

describe("publish-stgit-stack", () => {
  it("plans obsolete-ref deletion without mutating the remote in check mode", () => {
    const fixture = seedPublication();
    try {
      const result = run(fixture.repo, "--check");
      assert.strictEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
      assert.include(result.stdout, `delete ${fixture.obsoleteRef}`);
      assert.strictEqual(
        gitAt(fixture.remote, "rev-parse", "refs/heads/main"),
        fixture.repo.git("rev-parse", "HEAD~2"),
      );
      assert.strictEqual(
        gitAt(fixture.remote, "rev-parse", fixture.obsoleteRef),
        fixture.repo.git("rev-parse", "HEAD~2"),
      );
    } finally {
      fixture.repo.cleanup();
      NodeFS.rmSync(fixture.remote, { recursive: true, force: true });
    }
  });

  it("atomically publishes main and metadata while deleting obsolete refs", () => {
    const fixture = seedPublication();
    try {
      const result = run(fixture.repo, "--push");
      assert.strictEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
      assert.strictEqual(gitAt(fixture.remote, "rev-parse", "refs/heads/main"), fixture.head);
      assert.throws(() => gitAt(fixture.remote, "rev-parse", "--verify", fixture.obsoleteRef));
      const backups = gitAt(
        fixture.remote,
        "for-each-ref",
        "--format=%(refname)",
        "refs/heads/backup/manual",
      );
      assert.include(backups, "refs/heads/backup/manual/stgit-");
    } finally {
      fixture.repo.cleanup();
      NodeFS.rmSync(fixture.remote, { recursive: true, force: true });
    }
  });
});
