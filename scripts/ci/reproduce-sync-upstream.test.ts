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
const syncTargetRef = "refs/heads/sync-target";
const releaseTargetRef = "refs/heads/release-target";

const stgBin = (() => {
  if (process.env.CI_REPAIR_BOT_STG_BIN) return process.env.CI_REPAIR_BOT_STG_BIN;
  const found = NodeChildProcess.spawnSync("sh", ["-c", "command -v stg"], { encoding: "utf8" });
  return found.status === 0 ? found.stdout.trim() : undefined;
})();

type DriverResult = {
  readonly status: number;
  readonly output: string;
  readonly ghStatus: string | undefined;
  readonly ghPatch: string | undefined;
  readonly ghFiles: readonly string[];
};

const parseGithubOutput = (contents: string): Omit<DriverResult, "status" | "output"> => {
  const status = /^status=(.*)$/m.exec(contents)?.[1];
  const patch = /^patch=(.*)$/m.exec(contents)?.[1];
  const filesBlock = /^files<<EOF\n([\s\S]*?)\nEOF$/m.exec(contents)?.[1];
  return {
    ghStatus: status,
    ghPatch: patch || undefined,
    ghFiles: filesBlock ? filesBlock.split("\n").filter(Boolean) : [],
  };
};

const createUpstreamRemote = (
  fromRepo: FixtureRepo,
  releaseFile: string,
  releaseContents: string,
): string => {
  const bareDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-sync-upstream-"));
  NodeFS.rmSync(bareDir, { recursive: true, force: true });
  NodeChildProcess.execFileSync("/usr/bin/git", ["clone", "--bare", fromRepo.dir, bareDir], {
    stdio: "ignore",
  });
  const cloneDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-sync-clone-"));
  try {
    NodeChildProcess.execFileSync("/usr/bin/git", ["clone", bareDir, cloneDir], {
      stdio: "ignore",
    });
    const git = (...args: readonly string[]): string =>
      NodeChildProcess.execFileSync("/usr/bin/git", [...args], {
        cwd: cloneDir,
        encoding: "utf8",
      }).trim();
    git("config", "user.email", "upstream@example.com");
    git("config", "user.name", "Upstream");
    git("config", "commit.gpgsign", "false");
    git("checkout", "-b", "release-target");
    const target = NodePath.join(cloneDir, releaseFile);
    NodeFS.mkdirSync(NodePath.dirname(target), { recursive: true });
    NodeFS.writeFileSync(target, releaseContents);
    git("add", "-A");
    git("commit", "-m", "upstream: new release");
    git("push", "origin", `HEAD:${releaseTargetRef}`);
  } finally {
    NodeFS.rmSync(cloneDir, { recursive: true, force: true });
  }
  return bareDir;
};

const convertCommitsToStack = (repo: FixtureRepo, count: number): readonly string[] => {
  repo.git("branch", "-m", "stgit/adopt");
  NodeChildProcess.execFileSync(stgBin!, ["init"], { cwd: repo.dir, stdio: "ignore" });
  NodeChildProcess.execFileSync(stgBin!, ["uncommit", "--number", String(count)], {
    cwd: repo.dir,
    stdio: "ignore",
  });
  return NodeChildProcess.execFileSync(stgBin!, ["series", "--noprefix"], {
    cwd: repo.dir,
    encoding: "utf8",
  })
    .trim()
    .split("\n")
    .filter(Boolean);
};

const runDriver = (repo: FixtureRepo, conflictMode = "fail"): DriverResult => {
  const outputDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-sync-output-"));
  const githubOutput = NodePath.join(outputDir, "github_output");
  NodeFS.writeFileSync(githubOutput, "");
  try {
    const result = NodeChildProcess.spawnSync(script, [], {
      cwd: repo.dir,
      encoding: "utf8",
      env: {
        ...process.env,
        CI_REPAIR_BOT_UPSTREAM_TARGET: syncTargetRef,
        CI_REPAIR_BOT_UPSTREAM_SOURCE_REF: releaseTargetRef,
        CI_REPAIR_BOT_UPSTREAM_REMOTE: "upstream",
        CI_REPAIR_BOT_METADATA_REMOTE: "",
        CI_REPAIR_BOT_GIT_BIN: "/usr/bin/git",
        CI_REPAIR_BOT_STG_BIN: stgBin,
        CI_REPAIR_BOT_CONFLICT_MODE: conflictMode,
        GITHUB_OUTPUT: githubOutput,
      },
    });
    return {
      status: result.status ?? 1,
      output: `${result.stdout ?? ""}${result.stderr ?? ""}`,
      ...parseGithubOutput(NodeFS.readFileSync(githubOutput, "utf8")),
    };
  } finally {
    NodeFS.rmSync(outputDir, { recursive: true, force: true });
  }
};

const suite = stgBin ? describe : describe.skip;

suite("reproduce-sync-upstream StGit replay", () => {
  it("rebases the ordered series and preserves patch names and count", () => {
    const repo = createFixtureRepo();
    let remote: string | undefined;
    try {
      repo.writeFile("shared/base.ts", "export const base = 0;\n");
      repo.commitAll("upstream: shared base");
      remote = createUpstreamRemote(repo, "upstream/new.ts", "export const next = true;\n");
      repo.writeFile("topics/a.ts", "export const a = 1;\n");
      repo.commitAll("feat: topic one");
      repo.writeFile("topics/b.ts", "export const b = 1;\n");
      repo.commitAll("feat: topic two");
      const before = convertCommitsToStack(repo, 2);
      repo.git("remote", "add", "upstream", remote);

      const result = runDriver(repo);
      assert.strictEqual(result.status, 0, result.output);
      assert.strictEqual(result.ghStatus, "clean");
      const after = NodeChildProcess.execFileSync(stgBin!, ["series", "--noprefix"], {
        cwd: repo.dir,
        encoding: "utf8",
      })
        .trim()
        .split("\n");
      assert.deepStrictEqual(after, before);
      assert.strictEqual(repo.git("rev-list", "--count", `${syncTargetRef}..HEAD`), "2");
    } finally {
      repo.cleanup();
      if (remote) NodeFS.rmSync(remote, { recursive: true, force: true });
    }
  });

  it("reports the failing patch and restores the original stack after a conflict", () => {
    const repo = createFixtureRepo();
    let remote: string | undefined;
    try {
      repo.writeFile("shared/base.ts", "export const base = 0;\n");
      repo.commitAll("upstream: shared base");
      remote = createUpstreamRemote(repo, "shared/base.ts", "export const base = 100;\n");
      repo.writeFile("shared/base.ts", "export const base = 1;\n");
      repo.commitAll("feat: conflicting concern");
      repo.writeFile("topics/b.ts", "export const b = 1;\n");
      repo.commitAll("feat: later concern");
      const names = convertCommitsToStack(repo, 2);
      repo.git("remote", "add", "upstream", remote);
      const startingHead = repo.git("rev-parse", "HEAD");

      const result = runDriver(repo, "output");
      assert.strictEqual(result.status, 0, result.output);
      assert.strictEqual(result.ghStatus, "conflict");
      assert.strictEqual(result.ghPatch, names[0]);
      assert.deepStrictEqual(result.ghFiles, ["shared/base.ts"]);
      assert.include(result.output, "retire");
      assert.include(result.output, "relocate");
      assert.include(result.output, "Never create a patch during a rebase");
      assert.strictEqual(repo.git("rev-parse", "HEAD"), startingHead);
      assert.strictEqual(repo.git("status", "--porcelain"), "");
      assert.strictEqual(repo.git("branch", "--show-current"), "stgit/adopt");
      assert.deepStrictEqual(convertSeries(repo), names);
    } finally {
      repo.cleanup();
      if (remote) NodeFS.rmSync(remote, { recursive: true, force: true });
    }
  });

  it("fails on a metadata head mismatch before replay", () => {
    const repo = createFixtureRepo();
    try {
      repo.writeFile("topics/a.ts", "export const a = 1;\n");
      repo.commitAll("feat: concern");
      convertCommitsToStack(repo, 1);
      repo.writeFile("outside.txt", "plain commit\n");
      repo.commitAll("chore: accidental plain commit");
      const result = runDriver(repo);
      assert.notStrictEqual(result.status, 0);
      assert.include(
        result.output,
        "but the checked-out main is",
        "metadata mismatch must stop before mutation",
      );
    } finally {
      repo.cleanup();
    }
  });
});

const convertSeries = (repo: FixtureRepo): readonly string[] =>
  NodeChildProcess.execFileSync(stgBin!, ["series", "--noprefix"], {
    cwd: repo.dir,
    encoding: "utf8",
  })
    .trim()
    .split("\n")
    .filter(Boolean);
