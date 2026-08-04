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
const script = NodePath.join(repoRoot, "scripts/ci/prepare-release-tag");

const seedForkRepo = (repo: FixtureRepo): void => {
  repo.writeFile("apps/server/package.json", '{\n  "version": "0.0.0"\n}\n');
  repo.writeFile("apps/desktop/package.json", '{\n  "version": "0.0.0"\n}\n');
  repo.writeFile("apps/web/package.json", '{\n  "version": "0.0.0"\n}\n');
  repo.writeFile("packages/contracts/package.json", '{\n  "version": "0.0.0"\n}\n');
  repo.writeFile("pnpm-lock.yaml", "lockfileVersion: '9.0'\n");
  repo.commitAll("fork: seed manifests");
};

const runPrepare = (repo: FixtureRepo, tag: string): string => {
  const outputFile = NodePath.join(repo.dir, "gh-output");
  NodeChildProcess.execFileSync(script, [], {
    cwd: repo.dir,
    encoding: "utf8",
    env: {
      ...process.env,
      RELEASE_TAG: tag,
      SYNC_SKIP_INSTALL: "1",
      GITHUB_OUTPUT: outputFile,
      SYNC_GIT_BIN: "/usr/bin/git",
    },
  });
  return NodeChildProcess.execFileSync("/bin/cat", [outputFile], { encoding: "utf8" });
};

const outputValue = (output: string, key: string): string => {
  const line = output.split("\n").find((entry) => entry.startsWith(`${key}=`));
  assert.isDefined(line, `expected ${key} in step output`);
  return line!.slice(key.length + 1);
};

const createBareRemote = (): {
  readonly dir: string;
  readonly gitDir: string;
  readonly cleanup: () => void;
} => {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-release-remote-"));
  const gitDir = NodePath.join(dir, "origin.git");
  NodeChildProcess.execFileSync("/usr/bin/git", ["init", "--bare", gitDir], {
    stdio: "ignore",
  });
  return {
    dir,
    gitDir,
    cleanup: () => NodeFS.rmSync(dir, { recursive: true, force: true }),
  };
};

const remoteRef = (gitDir: string, ref: string): string =>
  NodeChildProcess.execFileSync("/usr/bin/git", ["--git-dir", gitDir, "rev-parse", ref], {
    encoding: "utf8",
  }).trim();

const remoteHasRef = (gitDir: string, ref: string): boolean =>
  NodeChildProcess.spawnSync(
    "/usr/bin/git",
    ["--git-dir", gitDir, "show-ref", "--verify", "--quiet", ref],
    { stdio: "ignore" },
  ).status === 0;

const pushPreparedRelease = (
  repo: FixtureRepo,
  {
    leaseSha,
    mainSha,
    prepSha,
    tag,
  }: {
    readonly leaseSha: string;
    readonly mainSha: string;
    readonly prepSha: string;
    readonly tag: string;
  },
): void => {
  assert.strictEqual(repo.git("rev-parse", `${tag}^{commit}`), prepSha);
  if (prepSha !== mainSha) {
    assert.strictEqual(repo.git("rev-parse", `${prepSha}^`), mainSha);
  }

  repo.git("push", "origin", `+${leaseSha}:refs/heads/backup/test-release`);
  repo.git(
    "push",
    `--force-with-lease=refs/heads/main:${leaseSha}`,
    "origin",
    `${mainSha}:refs/heads/main`,
  );
  repo.git("push", "origin", `refs/tags/${tag}:refs/tags/${tag}`);
};

describe("prepare-release-tag", () => {
  it("keeps the prep commit off main and points the tag at it", () => {
    const repo = createFixtureRepo();
    try {
      seedForkRepo(repo);
      const headBefore = repo.git("rev-parse", "HEAD");

      const output = runPrepare(repo, "v1.2.3-fork.1");
      const mainSha = outputValue(output, "main_sha");
      const prepSha = outputValue(output, "prep_sha");

      assert.strictEqual(mainSha, headBefore, "main must stay at the rebased head");
      assert.notStrictEqual(prepSha, mainSha, "prep commit must be a new commit");
      assert.strictEqual(
        repo.git("rev-parse", `${prepSha}^`),
        mainSha,
        "prep commit must be a direct child of main",
      );
      assert.strictEqual(repo.git("rev-parse", "v1.2.3-fork.1^{commit}"), prepSha);
    } finally {
      repo.cleanup();
    }
  });

  it("REGRESSION: main accumulates zero release-prep commits across repeated syncs", () => {
    const repo = createFixtureRepo();
    try {
      seedForkRepo(repo);

      for (const tag of ["v1.2.3-fork.1", "v1.2.4-fork.1", "v1.2.5-fork.1"]) {
        const output = runPrepare(repo, tag);
        const mainSha = outputValue(output, "main_sha");
        // Simulate the workflow pushing main at the pre-prep sha.
        repo.git("reset", "--hard", mainSha);
      }

      const log = repo.git("log", "--format=%s", "main");
      assert.notInclude(
        log,
        "chore(release): prepare",
        "REGRESSION: release-prep commits must never land on main",
      );
      assert.strictEqual(repo.git("rev-list", "--count", "main"), "2");
    } finally {
      repo.cleanup();
    }
  });

  it("stamps the release version into every manifest at the tagged commit", () => {
    const repo = createFixtureRepo();
    try {
      seedForkRepo(repo);
      const output = runPrepare(repo, "v1.2.3-fork.1");
      const prepSha = outputValue(output, "prep_sha");

      const manifest = repo.git("show", `${prepSha}:apps/server/package.json`);
      assert.include(manifest, '"version": "1.2.3-fork.1"');
    } finally {
      repo.cleanup();
    }
  });

  it("publishes the stamped child by tag while remote main stays at its parent", () => {
    const repo = createFixtureRepo();
    const remote = createBareRemote();
    try {
      seedForkRepo(repo);
      repo.git("remote", "add", "origin", remote.gitDir);
      repo.git("push", "-u", "origin", "main");
      const leaseSha = remoteRef(remote.gitDir, "refs/heads/main");

      const output = runPrepare(repo, "v1.2.3-fork.1");
      const mainSha = outputValue(output, "main_sha");
      const prepSha = outputValue(output, "prep_sha");
      const tag = outputValue(output, "tag");

      pushPreparedRelease(repo, { leaseSha, mainSha, prepSha, tag });

      assert.strictEqual(remoteRef(remote.gitDir, "refs/heads/main"), mainSha);
      assert.strictEqual(remoteRef(remote.gitDir, "refs/heads/backup/test-release"), leaseSha);
      assert.strictEqual(remoteRef(remote.gitDir, `refs/tags/${tag}^{commit}`), prepSha);
      assert.strictEqual(remoteRef(remote.gitDir, `${prepSha}^`), mainSha);
    } finally {
      repo.cleanup();
      remote.cleanup();
    }
  });

  it("REGRESSION: a stale explicit main lease rejects the rewrite before tag publication", () => {
    const repo = createFixtureRepo();
    const remote = createBareRemote();
    try {
      seedForkRepo(repo);
      repo.git("remote", "add", "origin", remote.gitDir);
      repo.git("push", "-u", "origin", "main");
      const staleLeaseSha = remoteRef(remote.gitDir, "refs/heads/main");

      const output = runPrepare(repo, "v1.2.3-fork.1");
      const mainSha = outputValue(output, "main_sha");
      const prepSha = outputValue(output, "prep_sha");
      const tag = outputValue(output, "tag");

      // Model a concurrent writer advancing main after this workflow recorded
      // its lease. The release tag is deliberately still local-only.
      repo.git("push", "origin", `${prepSha}:refs/heads/main`);

      assert.throws(() =>
        pushPreparedRelease(repo, {
          leaseSha: staleLeaseSha,
          mainSha,
          prepSha,
          tag,
        }),
      );
      assert.strictEqual(remoteRef(remote.gitDir, "refs/heads/main"), prepSha);
      assert.isFalse(remoteHasRef(remote.gitDir, `refs/tags/${tag}`));
    } finally {
      repo.cleanup();
      remote.cleanup();
    }
  });
});
