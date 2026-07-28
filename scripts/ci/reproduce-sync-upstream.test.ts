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
const script = NodePath.join(repoRoot, "scripts/ci/reproduce-sync-upstream");

const SYNC_TARGET_REF = "refs/heads/sync-target";
const RELEASE_TARGET_REF = "refs/heads/release-target";

type DriverResult = {
  readonly status: number;
  readonly output: string;
  readonly ghStatus: string | undefined;
  readonly ghFiles: readonly string[];
};

/** Parses the `key=value` / `key<<EOF ... EOF` GITHUB_OUTPUT format. */
const parseGithubOutput = (
  contents: string,
): { status: string | undefined; files: readonly string[] } => {
  const statusMatch = /^status=(.*)$/m.exec(contents);
  const filesMatch = /^files<<EOF\n([\s\S]*?)\nEOF$/m.exec(contents);
  const files =
    filesMatch?.[1] === undefined
      ? []
      : filesMatch[1].split("\n").filter((line) => line.length > 0);
  return { status: statusMatch?.[1], files };
};

/**
 * Creates a bare "upstream" remote with two refs:
 *   - `main`               the old upstream tip the fork's topic stack is based on
 *   - `refs/heads/release-target` the new upstream release being synced onto
 *
 * Mirrors compact-stack.test.ts's createBareOrigin/advanceBareRemote pattern:
 * a real bare repo reachable only via a local filesystem path, so the driver's
 * `remote add`/`fetch` calls exercise real git plumbing without touching the
 * network or the real pingdotgg/t3code repo.
 */
const createUpstreamRemote = (
  fromRepo: FixtureRepo,
  releaseFile: string,
  releaseContents: string,
): string => {
  const bareDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-sync-fixture-upstream-"));
  NodeFS.rmSync(bareDir, { recursive: true, force: true });
  NodeChildProcess.execFileSync("/usr/bin/git", ["clone", "--bare", fromRepo.dir, bareDir], {
    stdio: "ignore",
  });

  const cloneDir = NodeFS.mkdtempSync(
    NodePath.join(NodeOS.tmpdir(), "t3-sync-fixture-upstream-clone-"),
  );
  try {
    NodeChildProcess.execFileSync("/usr/bin/git", ["clone", bareDir, cloneDir], {
      stdio: "ignore",
    });
    const run = (...args: readonly string[]): string =>
      NodeChildProcess.execFileSync("/usr/bin/git", [...args], {
        cwd: cloneDir,
        encoding: "utf8",
      }).trim();
    run("config", "user.email", "upstream@example.com");
    run("config", "user.name", "Upstream");
    run("config", "commit.gpgsign", "false");
    run("checkout", "-b", "release-target");
    const target = NodePath.join(cloneDir, releaseFile);
    NodeFS.mkdirSync(NodePath.dirname(target), { recursive: true });
    NodeFS.writeFileSync(target, releaseContents);
    run("add", "-A");
    run("commit", "-m", "upstream: new release");
    run("push", "origin", `HEAD:${RELEASE_TARGET_REF}`);
  } finally {
    NodeFS.rmSync(cloneDir, { recursive: true, force: true });
  }

  return bareDir;
};

const runDriver = (repo: FixtureRepo, opts: { readonly conflictMode?: string }): DriverResult => {
  const outputDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-sync-fixture-output-"));
  const githubOutput = NodePath.join(outputDir, "github_output");
  NodeFS.writeFileSync(githubOutput, "");

  try {
    const result = NodeChildProcess.spawnSync(script, [], {
      cwd: repo.dir,
      encoding: "utf8",
      env: {
        ...process.env,
        CI_REPAIR_BOT_UPSTREAM_TARGET: SYNC_TARGET_REF,
        CI_REPAIR_BOT_UPSTREAM_SOURCE_REF: RELEASE_TARGET_REF,
        CI_REPAIR_BOT_UPSTREAM_REMOTE: "upstream",
        CI_REPAIR_BOT_GIT_BIN: "/usr/bin/git",
        CI_REPAIR_BOT_CONFLICT_MODE: opts.conflictMode ?? "fail",
        GITHUB_OUTPUT: githubOutput,
        // rerere is opt-in; leaving SYNC_RERERE_CACHE unset here exercises
        // the "disabled" branch, matching most CI runs (hosted fallback).
      },
    });
    const { status: ghStatus, files: ghFiles } = parseGithubOutput(
      NodeFS.readFileSync(githubOutput, "utf8"),
    );
    return {
      status: result.status ?? 1,
      output: `${result.stdout ?? ""}${result.stderr ?? ""}`,
      ghStatus,
      ghFiles,
    };
  } finally {
    NodeFS.rmSync(outputDir, { recursive: true, force: true });
  }
};

describe("reproduce-sync-upstream", () => {
  it("rebases a clean topic stack onto the upstream target, keeping topics as separate commits", () => {
    const repo = createFixtureRepo();
    let bareDir: string | undefined;
    try {
      repo.writeFile("shared/base.ts", "export const base = 0;\n");
      repo.commitAll("upstream: shared base");

      bareDir = createUpstreamRemote(
        repo,
        "upstream/new-feature.ts",
        "export const feature = true;\n",
      );

      repo.writeFile("topics/a.ts", "export const a = 1;\n");
      repo.commitAll("fork: topic one");
      repo.writeFile("topics/b.ts", "export const b = 1;\n");
      repo.commitAll("fork: topic two");

      repo.git("remote", "add", "upstream", bareDir);

      const result = runDriver(repo, {});
      assert.strictEqual(result.status, 0, result.output);
      assert.strictEqual(result.ghStatus, "clean");

      // REGRESSION-guard: the squash driver this replaced collapsed the
      // entire fork delta into one commit named "chore(sync): replay fork
      // patch onto ...". A correct rebase must instead carry each topic
      // forward as its own commit.
      const log = repo.git("log", "--format=%s", `${SYNC_TARGET_REF}..HEAD`);
      const messages = log.split("\n");
      assert.deepStrictEqual(
        messages,
        ["fork: topic two", "fork: topic one"],
        "topic commits must survive the rebase as separate commits, not collapse into one squash commit",
      );
      assert.strictEqual(
        repo.git("rev-list", "--count", `${SYNC_TARGET_REF}..HEAD`),
        "2",
        "exactly the two topic commits must be replayed -- no extra squash/merge commit",
      );
    } finally {
      repo.cleanup();
      if (bareDir !== undefined) NodeFS.rmSync(bareDir, { recursive: true, force: true });
    }
  });

  it("folds a fixup! commit into its target topic via --autosquash", () => {
    const repo = createFixtureRepo();
    let bareDir: string | undefined;
    try {
      repo.writeFile("shared/base.ts", "export const base = 0;\n");
      repo.commitAll("upstream: shared base");

      bareDir = createUpstreamRemote(
        repo,
        "upstream/new-feature.ts",
        "export const feature = true;\n",
      );

      repo.writeFile("topics/a.ts", "export const a = 1;\n");
      repo.commitAll("fork: topic one");
      // An integration fixup landed on top, as the fork's commit discipline
      // requires (fixup!, not a new ad hoc commit).
      repo.writeFile("topics/a.ts", "export const a = 1;\nexport const aFixed = true;\n");
      repo.commitAll("fixup! fork: topic one");
      repo.writeFile("topics/b.ts", "export const b = 1;\n");
      repo.commitAll("fork: topic two");

      repo.git("remote", "add", "upstream", bareDir);

      const result = runDriver(repo, {});
      assert.strictEqual(result.status, 0, result.output);
      assert.strictEqual(result.ghStatus, "clean");

      const log = repo.git("log", "--format=%s", `${SYNC_TARGET_REF}..HEAD`);
      const messages = log.split("\n");
      assert.deepStrictEqual(
        messages,
        ["fork: topic two", "fork: topic one"],
        "REGRESSION: the fixup! commit must be folded into 'fork: topic one', not left as its own commit",
      );
      assert.strictEqual(
        repo.git("rev-list", "--count", `${SYNC_TARGET_REF}..HEAD`),
        "2",
        "the fixup! commit must not count as a third commit after autosquash folds it",
      );

      const topicAContents = repo.git("show", "HEAD~1:topics/a.ts");
      assert.include(
        topicAContents,
        "aFixed",
        "the fixup!'s content must actually be folded into topic one's tree, not merely have its commit disappear",
      );
    } finally {
      repo.cleanup();
      if (bareDir !== undefined) NodeFS.rmSync(bareDir, { recursive: true, force: true });
    }
  });

  it("reports status=conflict with the full conflict-file list and restores the starting HEAD", () => {
    const repo = createFixtureRepo();
    let bareDir: string | undefined;
    try {
      repo.writeFile("shared/base.ts", "export const base = 0;\n");
      repo.commitAll("upstream: shared base");

      // The new upstream release touches the same unowned file the fork
      // also touches below, on the same line, so replaying the fork commit
      // produces a genuine merge conflict that no ownership rule resolves.
      bareDir = createUpstreamRemote(repo, "shared/base.ts", "export const base = 100;\n");

      repo.writeFile("shared/base.ts", "export const base = 1;\n");
      repo.commitAll("fork: topic one (conflicts with upstream)");
      repo.writeFile("topics/b.ts", "export const b = 1;\n");
      repo.commitAll("fork: topic two");

      repo.git("remote", "add", "upstream", bareDir);
      const startingHead = repo.git("rev-parse", "HEAD");

      const result = runDriver(repo, { conflictMode: "output" });

      assert.strictEqual(result.status, 0, result.output); // CONFLICT_MODE=output -> exit 0
      assert.strictEqual(result.ghStatus, "conflict");
      assert.deepStrictEqual(
        [...result.ghFiles].sort(),
        ["shared/base.ts"],
        "the full conflict chain must name every unresolved file, not just the first one hit",
      );
      assert.include(result.output, "full conflict chain:");
      assert.include(result.output, "shared/base.ts");
      assert.include(
        result.output,
        "Is the fork's side still needed at all?",
        "REGRESSION: every conflict report must ask retire-then-narrow-then-adapt " +
          "before reconciliation, since resolving a conflict without asking that first " +
          "silently preserves patches that no longer need to exist",
      );
      assert.include(result.output, "Fix the PATCH, never add a repair commit beside it.");

      // A failed run must leave the repo exactly as it found it.
      assert.strictEqual(
        repo.git("rev-parse", "HEAD"),
        startingHead,
        "REGRESSION: a conflict must restore the starting HEAD, not leave the repo mid-rebase",
      );
      assert.strictEqual(
        repo.git("status", "--porcelain"),
        "",
        "the working tree must be clean after restore",
      );
      assert.strictEqual(
        repo.git("rev-parse", "--abbrev-ref", "HEAD"),
        "main",
        "HEAD must be back on the original branch, not detached mid-rebase",
      );
    } finally {
      repo.cleanup();
      if (bareDir !== undefined) NodeFS.rmSync(bareDir, { recursive: true, force: true });
    }
  });

  it("fails the run when CONFLICT_MODE is the fail default", () => {
    const repo = createFixtureRepo();
    let bareDir: string | undefined;
    try {
      repo.writeFile("shared/base.ts", "export const base = 0;\n");
      repo.commitAll("upstream: shared base");
      bareDir = createUpstreamRemote(repo, "shared/base.ts", "export const base = 100;\n");
      repo.writeFile("shared/base.ts", "export const base = 1;\n");
      repo.commitAll("fork: topic one (conflicts with upstream)");
      repo.git("remote", "add", "upstream", bareDir);

      const result = runDriver(repo, {});
      assert.notStrictEqual(
        result.status,
        0,
        "default conflict mode must fail the run (non-zero exit)",
      );
      assert.strictEqual(result.ghStatus, "conflict");
    } finally {
      repo.cleanup();
      if (bareDir !== undefined) NodeFS.rmSync(bareDir, { recursive: true, force: true });
    }
  });
});
