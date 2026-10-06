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
const script = NodePath.join(repoRoot, "scripts/ci/record-main-lease");

const createBareRemote = (): {
  readonly dir: string;
  readonly gitDir: string;
  readonly cleanup: () => void;
} => {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-lease-remote-"));
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

const runRecordMainLease = (
  repo: FixtureRepo,
): { readonly status: number; readonly output: string; readonly stepOutput: string } => {
  const outputFile = NodePath.join(repo.dir, "gh-output");
  try {
    const output = NodeChildProcess.execFileSync(script, [], {
      cwd: repo.dir,
      encoding: "utf8",
      env: {
        ...process.env,
        GITHUB_OUTPUT: outputFile,
        SYNC_GIT_BIN: "/usr/bin/git",
      },
    });
    return {
      status: 0,
      output,
      stepOutput: NodeFS.readFileSync(outputFile, "utf8"),
    };
  } catch (error) {
    const failure = error as { status?: number; stdout?: string; stderr?: string };
    return {
      status: failure.status ?? 1,
      output: `${failure.stdout ?? ""}${failure.stderr ?? ""}`,
      stepOutput: NodeFS.existsSync(outputFile) ? NodeFS.readFileSync(outputFile, "utf8") : "",
    };
  }
};

describe("record-main-lease", () => {
  it("binds the lease to the exact checked-out main commit", () => {
    const repo = createFixtureRepo();
    const remote = createBareRemote();
    try {
      repo.git("remote", "add", "origin", remote.gitDir);
      repo.git("push", "-u", "origin", "main");
      const startSha = repo.git("rev-parse", "HEAD");

      const result = runRecordMainLease(repo);

      assert.strictEqual(result.status, 0, result.output);
      assert.include(result.stepOutput, `main_sha=${startSha}`);
    } finally {
      repo.cleanup();
      remote.cleanup();
    }
  });

  it("REGRESSION: rejects a queued checkout after remote main advances", () => {
    const repo = createFixtureRepo();
    const remote = createBareRemote();
    try {
      repo.git("remote", "add", "origin", remote.gitDir);
      repo.git("push", "-u", "origin", "main");
      const staleCheckoutSha = repo.git("rev-parse", "HEAD");

      repo.writeFile("newer.txt", "newer main\n");
      const newerRemoteSha = repo.commitAll("feat: advance main");
      repo.git("push", "origin", "main");
      repo.git("switch", "--detach", staleCheckoutSha);

      const result = runRecordMainLease(repo);

      assert.notStrictEqual(result.status, 0);
      assert.include(result.output, "Stale queued checkout");
      assert.include(result.output, staleCheckoutSha);
      assert.include(result.output, newerRemoteSha);
      assert.strictEqual(result.stepOutput, "");
    } finally {
      repo.cleanup();
      remote.cleanup();
    }
  });
});
