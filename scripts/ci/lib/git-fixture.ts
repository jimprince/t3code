// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

export type FixtureRepo = {
  readonly dir: string;
  readonly git: (...args: readonly string[]) => string;
  readonly writeFile: (rel: string, contents: string) => void;
  readonly commitAll: (message: string) => string;
  readonly cleanup: () => void;
};

/**
 * Creates a throwaway git repo with a single commit on `main`.
 *
 * Uses the system git binary directly, bypassing any interactive safety
 * wrappers on PATH — the same reason `reproduce-sync-upstream` honours
 * CI_REPAIR_BOT_GIT_BIN. Fixture repos are disposable by construction.
 */
export const createFixtureRepo = (): FixtureRepo => {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-fork-fixture-"));

  const git = (...args: readonly string[]): string =>
    NodeChildProcess.execFileSync("/usr/bin/git", [...args], {
      cwd: dir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();

  const writeFile = (rel: string, contents: string): void => {
    const target = NodePath.join(dir, rel);
    NodeFS.mkdirSync(NodePath.dirname(target), { recursive: true });
    NodeFS.writeFileSync(target, contents);
  };

  const commitAll = (message: string): string => {
    git("add", "-A");
    git("commit", "-m", message);
    return git("rev-parse", "HEAD");
  };

  git("init", "-b", "main");
  git("config", "user.email", "fixture@example.com");
  git("config", "user.name", "Fixture");
  git("config", "commit.gpgsign", "false");
  writeFile("README.md", "fixture\n");
  commitAll("chore: init");

  return {
    dir,
    git,
    writeFile,
    commitAll,
    cleanup: () => NodeFS.rmSync(dir, { recursive: true, force: true }),
  };
};
