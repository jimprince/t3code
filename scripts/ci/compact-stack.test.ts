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
const script = NodePath.join(repoRoot, "scripts/ci/compact-stack");

const runCompact = (
  repo: FixtureRepo,
  topicsPath: string,
  base: string,
): { readonly status: number; readonly output: string } => {
  // Use spawnSync (not execFileSync) so stderr is captured on the SUCCESS
  // path too, not just on failure -- the freshness gate's diagnostics
  // (SKIPPED / PASS / FAILED) all go to stderr, matching the rest of this
  // script's convention of writing gate output to stderr.
  const result = NodeChildProcess.spawnSync(script, [], {
    cwd: repo.dir,
    encoding: "utf8",
    env: {
      ...process.env,
      COMPACT_BASE: base,
      COMPACT_SOURCE: "main",
      COMPACT_TARGET: "main-compact",
      COMPACT_TOPICS: topicsPath,
      SYNC_GIT_BIN: "/usr/bin/git",
    },
  });
  return {
    status: result.status ?? 1,
    output: `${result.stdout ?? ""}${result.stderr ?? ""}`,
  };
};

/**
 * Creates a bare "origin" remote by cloning a fixture repo's current state,
 * so it starts out identical to the fixture (origin/main == the fixture's
 * main, an ancestor relationship that trivially holds).
 */
const createBareOrigin = (repo: FixtureRepo): string => {
  const bareDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-fork-fixture-origin-"));
  NodeFS.rmSync(bareDir, { recursive: true, force: true });
  NodeChildProcess.execFileSync("/usr/bin/git", ["clone", "--bare", repo.dir, bareDir], {
    stdio: "ignore",
  });
  return bareDir;
};

/**
 * Lands one more commit directly on a bare remote's `main`, via a throwaway
 * clone -- simulating other work reaching origin/main that a local fork
 * checkout never fetched. This is the exact shape of the incident: origin
 * gets ahead while a stale local copy is used as COMPACT_SOURCE.
 */
const advanceBareRemote = (
  bareDir: string,
  relFile: string,
  contents: string,
  message: string,
): string => {
  const cloneDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-fork-fixture-remote-"));
  try {
    NodeChildProcess.execFileSync("/usr/bin/git", ["clone", bareDir, cloneDir], {
      stdio: "ignore",
    });
    const run = (...args: readonly string[]): string =>
      NodeChildProcess.execFileSync("/usr/bin/git", [...args], {
        cwd: cloneDir,
        encoding: "utf8",
      }).trim();
    run("config", "user.email", "fixture@example.com");
    run("config", "user.name", "Fixture");
    run("config", "commit.gpgsign", "false");
    const target = NodePath.join(cloneDir, relFile);
    NodeFS.mkdirSync(NodePath.dirname(target), { recursive: true });
    NodeFS.writeFileSync(target, contents);
    run("add", "-A");
    run("commit", "-m", message);
    run("push", "origin", "main");
    return run("rev-parse", "HEAD");
  } finally {
    NodeFS.rmSync(cloneDir, { recursive: true, force: true });
  }
};

/** Seeds a repo with a base commit plus several noisy fork commits. */
const seedForkStack = (repo: FixtureRepo): string => {
  repo.writeFile("src/app.ts", "export const app = 1;\n");
  const base = repo.commitAll("upstream: base");

  repo.writeFile("src/app.ts", "export const app = 2;\n");
  repo.commitAll("feat: change app");
  repo.writeFile("tools/cli.ts", "export const cli = true;\n");
  repo.commitAll("feat: add cli");
  repo.writeFile("tools/cli.ts", "export const cli = false;\n");
  repo.commitAll("fix(ci): repair Sync Upstream failure");
  repo.writeFile("docs/guide.md", "# guide\n");
  repo.commitAll("docs: add guide");

  return base;
};

describe("compact-stack", () => {
  it("collapses many commits into the declared topics with an identical tree", () => {
    const repo = createFixtureRepo();
    try {
      const base = seedForkStack(repo);
      const topics = NodePath.join(repo.dir, "topics.json");
      repo.writeFile(
        "topics.json",
        JSON.stringify([
          { message: "fork: tooling", paths: ["tools/"] },
          { message: "fork: docs", paths: ["docs/"] },
          { message: "fork(app): behaviour", paths: ["src/"] },
        ]),
      );

      const result = runCompact(repo, topics, base);
      assert.strictEqual(result.status, 0, result.output);
      assert.include(
        result.output,
        "Freshness gate SKIPPED: no 'origin' remote configured",
        "fixture repos have no remote -- the freshness gate must skip gracefully, not fail",
      );

      assert.strictEqual(
        repo.git("diff", "main", "main-compact"),
        "",
        "tree identity gate: compacted branch must be byte-identical",
      );
      assert.strictEqual(repo.git("rev-list", "--count", `${base}..main-compact`), "3");
    } finally {
      repo.cleanup();
    }
  });

  it("REGRESSION: restores the operator's starting branch after a successful render", () => {
    // Two prior incidents: this script used to leave HEAD checked out on
    // COMPACT_TARGET, and the operator ran later commands believing they
    // were still on their original branch. A successful render must still
    // create COMPACT_TARGET (so it can be inspected/pushed), but HEAD itself
    // must land back on the branch the operator started from.
    const repo = createFixtureRepo();
    try {
      const base = seedForkStack(repo);
      const startingBranch = repo.git("rev-parse", "--abbrev-ref", "HEAD");
      const startingSha = repo.git("rev-parse", "HEAD");
      const topics = NodePath.join(repo.dir, "topics.json");
      repo.writeFile(
        "topics.json",
        JSON.stringify([
          { message: "fork: tooling", paths: ["tools/"] },
          { message: "fork: docs", paths: ["docs/"] },
          { message: "fork(app): behaviour", paths: ["src/"] },
        ]),
      );

      const result = runCompact(repo, topics, base);
      assert.strictEqual(result.status, 0, result.output);

      assert.strictEqual(
        repo.git("rev-parse", "--abbrev-ref", "HEAD"),
        startingBranch,
        "REGRESSION: HEAD must be restored to the operator's starting branch, not left on COMPACT_TARGET",
      );
      assert.strictEqual(
        repo.git("rev-parse", "HEAD"),
        startingSha,
        "REGRESSION: the starting branch must not have moved",
      );
      // The render itself must still exist and be inspectable -- restoring
      // HEAD must not discard the work.
      assert.strictEqual(
        repo.git("rev-list", "--count", `${base}..main-compact`),
        "3",
        "main-compact must still exist with its topic commits after HEAD is restored",
      );
      assert.include(result.output, "Render landed on branch 'main-compact'");
      assert.include(result.output, `Restoring HEAD to '${startingBranch}'`);
    } finally {
      repo.cleanup();
    }
  });

  it("proceeds when origin/main is an ancestor of COMPACT_SOURCE", () => {
    const repo = createFixtureRepo();
    let bareDir: string | undefined;
    try {
      const base = seedForkStack(repo);
      const topics = NodePath.join(repo.dir, "topics.json");
      repo.writeFile(
        "topics.json",
        JSON.stringify([
          { message: "fork: tooling", paths: ["tools/"] },
          { message: "fork: docs", paths: ["docs/"] },
          { message: "fork(app): behaviour", paths: ["src/"] },
        ]),
      );

      // origin/main == COMPACT_SOURCE: the common case where the fork is
      // already current. A commit is its own ancestor, so this must pass.
      bareDir = createBareOrigin(repo);
      repo.git("remote", "add", "origin", bareDir);

      const result = runCompact(repo, topics, base);
      assert.strictEqual(result.status, 0, result.output);
      assert.include(result.output, "Freshness gate: PASS");

      assert.strictEqual(
        repo.git("diff", "main", "main-compact"),
        "",
        "tree identity gate: compacted branch must be byte-identical",
      );
    } finally {
      repo.cleanup();
      if (bareDir !== undefined) NodeFS.rmSync(bareDir, { recursive: true, force: true });
    }
  });

  it("REGRESSION: refuses to render when origin/main is ahead of a stale COMPACT_SOURCE", () => {
    const repo = createFixtureRepo();
    let bareDir: string | undefined;
    try {
      const base = seedForkStack(repo);
      const topics = NodePath.join(repo.dir, "topics.json");
      repo.writeFile(
        "topics.json",
        JSON.stringify([
          { message: "fork: tooling", paths: ["tools/"] },
          { message: "fork: docs", paths: ["docs/"] },
          { message: "fork(app): behaviour", paths: ["src/"] },
        ]),
      );

      const sourceSha = repo.git("rev-parse", "main");

      // origin starts identical to the fork checkout, then receives one more
      // commit the fork checkout never fetched -- exactly the shape of the
      // incident this gate exists to prevent.
      bareDir = createBareOrigin(repo);
      const originMainSha = advanceBareRemote(
        bareDir,
        "upstream/only-on-origin.ts",
        "export const onlyOnOrigin = true;\n",
        "upstream: land change the fork checkout never fetched",
      );
      repo.git("remote", "add", "origin", bareDir);

      const result = runCompact(repo, topics, base);

      assert.notStrictEqual(
        result.status,
        0,
        "must fail when origin/main is ahead of COMPACT_SOURCE",
      );
      assert.include(result.output, "Freshness gate FAILED");
      assert.include(result.output, sourceSha, "message must name the source SHA");
      assert.include(result.output, originMainSha, "message must name the origin/main SHA");
      assert.include(
        result.output,
        "origin/main has 1 commit(s) that COMPACT_SOURCE lacks",
        "message must state how many commits origin/main has that the source lacks",
      );
      assert.include(
        result.output,
        "Rebase COMPACT_SOURCE onto origin/main",
        "message must give a concrete remediation instruction",
      );

      // A refusal must leave the repo completely untouched: no half-built
      // target branch, and the source exactly where it was.
      assert.strictEqual(
        repo.git("branch", "--list", "main-compact"),
        "",
        "target branch must NOT be created on refusal",
      );
      assert.strictEqual(
        repo.git("rev-parse", "main"),
        sourceSha,
        "source branch must be unchanged",
      );
      assert.strictEqual(
        repo.git("rev-parse", "--abbrev-ref", "HEAD"),
        "main",
        "HEAD must remain on the source branch",
      );
    } finally {
      repo.cleanup();
      if (bareDir !== undefined) NodeFS.rmSync(bareDir, { recursive: true, force: true });
    }
  });

  it("REGRESSION: fails when a changed path is not covered by any topic", () => {
    const repo = createFixtureRepo();
    try {
      const base = seedForkStack(repo);
      const topics = NodePath.join(repo.dir, "topics.json");
      // docs/ deliberately omitted.
      repo.writeFile(
        "topics.json",
        JSON.stringify([
          { message: "fork: tooling", paths: ["tools/"] },
          { message: "fork(app): behaviour", paths: ["src/"] },
        ]),
      );

      const result = runCompact(repo, topics, base);
      assert.notStrictEqual(result.status, 0, "must fail when coverage is incomplete");
      assert.include(result.output, "docs/guide.md");
      assert.include(result.output, "not covered by any topic");
    } finally {
      repo.cleanup();
    }
  });

  it("REGRESSION: tree-identity gate fails when a topic's checkout silently drops a file", () => {
    // seedForkStack (above) has exactly one changed file per topic, so a
    // defect that checks out only the "first file per topic" is
    // indistinguishable from correct behaviour there -- that is why the
    // manual Step 5 proof needed a hand-built multi-file-per-topic repo
    // instead of this suite. This test seeds a topic with TWO changed files
    // so that class of defect is actually observable, then reproduces the
    // exact defect (checkout "${present_files[0]}" instead of
    // "${present_files[@]}") against a throwaway copy of the real script --
    // never against scripts/ci/compact-stack itself -- and asserts the tree
    // identity gate is what catches it.
    const repo = createFixtureRepo();
    try {
      repo.writeFile("tools/a.ts", "export const a = 1;\n");
      repo.writeFile("tools/b.ts", "export const b = 1;\n");
      const base = repo.commitAll("upstream: base");

      repo.writeFile("tools/a.ts", "export const a = 2;\n");
      repo.writeFile("tools/b.ts", "export const b = 2;\n");
      repo.commitAll("feat: touch both tool files");

      const topics = NodePath.join(repo.dir, "topics.json");
      repo.writeFile(
        "topics.json",
        JSON.stringify([{ message: "fork: tooling", paths: ["tools/"] }]),
      );

      const realSource = NodeFS.readFileSync(script, "utf8");
      const goodLine = 'git_cmd checkout "$COMPACT_SOURCE" -- "${present_files[@]}"';
      const droppedLine = 'git_cmd checkout "$COMPACT_SOURCE" -- "${present_files[0]}"';
      assert.include(
        realSource,
        goodLine,
        "compact-stack's checkout line changed shape; update this regression test to match",
      );
      const brokenSource = realSource.split(goodLine).join(droppedLine);
      assert.notStrictEqual(brokenSource, realSource, "the deliberate break did not apply");

      const brokenScript = NodePath.join(repo.dir, "broken-compact-stack");
      NodeFS.writeFileSync(brokenScript, brokenSource);

      let status: number;
      let output: string;
      try {
        output = NodeChildProcess.execFileSync("/bin/bash", [brokenScript], {
          cwd: repo.dir,
          encoding: "utf8",
          env: {
            ...process.env,
            COMPACT_BASE: base,
            COMPACT_SOURCE: "main",
            COMPACT_TARGET: "main-compact-broken",
            COMPACT_TOPICS: topics,
            SYNC_GIT_BIN: "/usr/bin/git",
          },
        });
        status = 0;
      } catch (error) {
        const failure = error as { status?: number; stdout?: string; stderr?: string };
        status = failure.status ?? 1;
        output = `${failure.stdout ?? ""}${failure.stderr ?? ""}`;
      }

      assert.notStrictEqual(status, 0, "must fail when a topic's checkout drops a file");
      assert.include(output, "Tree identity gate FAILED");
    } finally {
      repo.cleanup();
    }
  });
});
