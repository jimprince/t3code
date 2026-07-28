// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { assert, describe, it } from "@effect/vitest";
import { createFixtureRepo, type FixtureRepo } from "./lib/git-fixture.ts";

const repoRoot = NodePath.resolve(
  NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
  "../..",
);
const script = NodePath.join(repoRoot, "scripts/ci/check-commit-discipline");

const runCheck = (
  repo: FixtureRepo,
  base: string,
  topicsPath: string,
): { readonly status: number; readonly output: string } => {
  try {
    const output = NodeChildProcess.execFileSync(script, [], {
      cwd: repo.dir,
      encoding: "utf8",
      env: {
        ...process.env,
        DISCIPLINE_BASE: base,
        DISCIPLINE_HEAD: "HEAD",
        DISCIPLINE_TOPICS: topicsPath,
        SYNC_GIT_BIN: "/usr/bin/git",
      },
    });
    return { status: 0, output };
  } catch (error) {
    const failure = error as { status?: number; stdout?: string; stderr?: string };
    return {
      status: failure.status ?? 1,
      output: `${failure.stdout ?? ""}${failure.stderr ?? ""}`,
    };
  }
};

const seedTopics = (repo: FixtureRepo): string => {
  repo.writeFile(
    "topics.json",
    JSON.stringify([
      { message: "fork: tooling", paths: ["tools/"] },
      { message: "fork(app): behaviour", paths: ["src/"] },
    ]),
  );
  repo.commitAll("chore: topics");
  return NodePath.join(repo.dir, "topics.json");
};

describe("check-commit-discipline", () => {
  it("accepts declared topic commits and fixup! commits", () => {
    const repo = createFixtureRepo();
    try {
      const topics = seedTopics(repo);
      const base = repo.git("rev-parse", "HEAD");

      repo.writeFile("tools/a.ts", "export const a = 1;\n");
      repo.commitAll("fork: tooling");
      repo.writeFile("src/b.ts", "export const b = 1;\n");
      repo.commitAll("fork(app): behaviour");
      repo.writeFile("tools/a.ts", "export const a = 2;\n");
      repo.commitAll("fixup! fork: tooling");

      const result = runCheck(repo, base, topics);
      assert.strictEqual(result.status, 0, result.output);
    } finally {
      repo.cleanup();
    }
  });

  it("REGRESSION: rejects an appended repair commit", () => {
    const repo = createFixtureRepo();
    try {
      const topics = seedTopics(repo);
      const base = repo.git("rev-parse", "HEAD");

      repo.writeFile("tools/a.ts", "export const a = 1;\n");
      repo.commitAll("fork: tooling");
      repo.writeFile("tools/a.ts", "export const a = 2;\n");
      repo.commitAll("fix(ci): repair Sync Upstream failure");

      const result = runCheck(repo, base, topics);
      assert.notStrictEqual(result.status, 0, "appended repair commits must be rejected");
      assert.include(result.output, "fix(ci): repair Sync Upstream failure");
      assert.include(result.output, "--fixup");
    } finally {
      repo.cleanup();
    }
  });

  it("allows release-prep commits, which are tagged but never on main", () => {
    const repo = createFixtureRepo();
    try {
      const topics = seedTopics(repo);
      const base = repo.git("rev-parse", "HEAD");

      repo.writeFile("tools/a.ts", "export const a = 1;\n");
      repo.commitAll("fork: tooling");
      repo.writeFile("tools/a.ts", "export const a = 3;\n");
      repo.commitAll("chore(release): prepare v1.2.3-fork.1");

      const result = runCheck(repo, base, topics);
      assert.strictEqual(result.status, 0, result.output);
    } finally {
      repo.cleanup();
    }
  });
});
