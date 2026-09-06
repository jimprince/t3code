// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { assert, describe, it } from "vite-plus/test";
import { createFixtureRepo, type FixtureRepo } from "./lib/git-fixture.ts";

const script = NodePath.resolve(import.meta.dirname, "list-release-tags-at-head");
const repoRoot = NodePath.resolve(import.meta.dirname, "../..");

function releaseTagsAtHead(repo: FixtureRepo): readonly string[] {
  const stdout = NodeChildProcess.execFileSync(script, [], {
    cwd: repo.dir,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, PATH: `/usr/bin:/bin:${process.env.PATH}` },
  });
  return stdout.split("\n").filter((line) => line !== "");
}

/** Adds a stamped child of HEAD, tags it, and leaves HEAD where it was. */
function tagPreparedChild(repo: FixtureRepo, tag: string, annotated: boolean): void {
  const head = repo.git("rev-parse", "HEAD");
  repo.writeFile("version", `${tag}\n`);
  repo.commitAll(`chore: stamp ${tag}`);
  if (annotated) repo.git("tag", "-a", tag, "-m", "prepared");
  else repo.git("tag", tag);
  repo.git("reset", "--hard", head);
}

describe("release tags at HEAD", () => {
  it("lists lightweight and annotated tags on HEAD itself", () => {
    const repo = createFixtureRepo();
    try {
      repo.writeFile("a.txt", "a\n");
      repo.commitAll("feat: a");
      repo.git("tag", "v1.0.0-nightly.1-fork.1");
      repo.git("tag", "-a", "v1.0.0-nightly.1-fork.2", "-m", "annotated");
      assert.deepEqual(releaseTagsAtHead(repo), [
        "v1.0.0-nightly.1-fork.1",
        "v1.0.0-nightly.1-fork.2",
      ]);
    } finally {
      repo.cleanup();
    }
  });

  it("lists tags on a prepared child whose first parent is HEAD", () => {
    const repo = createFixtureRepo();
    try {
      tagPreparedChild(repo, "v1.0.0-nightly.1-fork.3", false);
      tagPreparedChild(repo, "v1.0.0-nightly.1-fork.4", true);
      assert.deepEqual(releaseTagsAtHead(repo), [
        "v1.0.0-nightly.1-fork.3",
        "v1.0.0-nightly.1-fork.4",
      ]);
    } finally {
      repo.cleanup();
    }
  });

  it("ignores a tag reachable only through a merge's second parent", () => {
    const repo = createFixtureRepo();
    try {
      const base = repo.git("rev-parse", "HEAD");
      repo.writeFile("main.txt", "main\n");
      repo.commitAll("feat: main");
      repo.git("checkout", "-q", "-b", "side", base);
      repo.writeFile("side.txt", "side\n");
      repo.commitAll("feat: side");
      repo.git("merge", "--no-edit", "main");
      repo.git("tag", "v1.0.0-nightly.1-fork.5");
      repo.git("checkout", "-q", "main");
      assert.deepEqual(releaseTagsAtHead(repo), []);
    } finally {
      repo.cleanup();
    }
  });

  it("ignores ancestors, unrelated roots, and non-release tags", () => {
    const repo = createFixtureRepo();
    try {
      repo.git("tag", "v0.9.0-ancestor");
      repo.writeFile("a.txt", "a\n");
      repo.commitAll("feat: a");
      repo.git("tag", "upstream-v1.0.0");
      repo.git("tag", "nightly-v1.0.0");
      repo.git("checkout", "-q", "--orphan", "unrelated");
      repo.writeFile("other.txt", "other\n");
      repo.commitAll("chore: unrelated root");
      repo.git("tag", "v9.9.9-unrelated");
      repo.git("checkout", "-q", "main");
      assert.deepEqual(releaseTagsAtHead(repo), []);
    } finally {
      repo.cleanup();
    }
  });

  it("handles a tagged root commit at HEAD, which has no parent", () => {
    const repo = createFixtureRepo();
    try {
      repo.git("tag", "v1.0.0-nightly.1-fork.6");
      assert.deepEqual(releaseTagsAtHead(repo), ["v1.0.0-nightly.1-fork.6"]);
    } finally {
      repo.cleanup();
    }
  });

  it("ignores a tag that does not point at a commit", () => {
    const repo = createFixtureRepo();
    try {
      const tree = repo.git("rev-parse", "HEAD^{tree}");
      repo.git("tag", "-a", "v1.0.0-tree", "-m", "tree", tree);
      repo.writeFile("a.txt", "a\n");
      repo.commitAll("feat: a");
      repo.git("tag", "v1.0.0-nightly.1-fork.7");
      assert.deepEqual(releaseTagsAtHead(repo), ["v1.0.0-nightly.1-fork.7"]);
    } finally {
      repo.cleanup();
    }
  });

  it("prints nothing when the repo has no release tags", () => {
    const repo = createFixtureRepo();
    try {
      assert.deepEqual(releaseTagsAtHead(repo), []);
    } finally {
      repo.cleanup();
    }
  });

  it("resolves hundreds of tags with a constant number of git processes", () => {
    const repo = createFixtureRepo();
    const scratch = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-tag-scan-"));
    const gitLog = NodePath.join(scratch, "git-calls");
    const binDir = NodePath.join(scratch, "bin");
    try {
      for (let i = 0; i < 10; i += 1) {
        repo.writeFile("a.txt", `${i}\n`);
        repo.commitAll(`feat: ${i}`);
      }
      // 250 lightweight tags in one process; per-tag `git tag` would dominate
      // the fixture, not the scan under test.
      const history = repo.git("rev-list", "HEAD").split("\n");
      NodeChildProcess.execFileSync("/usr/bin/git", ["update-ref", "--stdin"], {
        cwd: repo.dir,
        input: history
          .flatMap((sha, index) =>
            Array.from({ length: 25 }, (_, n) => `create refs/tags/v0.${index}.${n} ${sha}\n`),
          )
          .join(""),
        stdio: ["pipe", "pipe", "pipe"],
      });
      tagPreparedChild(repo, "v1.0.0-nightly.1-fork.1", false);

      NodeFS.mkdirSync(binDir, { recursive: true });
      NodeFS.writeFileSync(
        NodePath.join(binDir, "git"),
        `#!/bin/sh\necho x >> ${JSON.stringify(gitLog)}\nexec /usr/bin/git "$@"\n`,
      );
      NodeFS.chmodSync(NodePath.join(binDir, "git"), 0o755);
      NodeFS.writeFileSync(gitLog, "");

      const stdout = NodeChildProcess.execFileSync(script, [], {
        cwd: repo.dir,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, PATH: `${binDir}:/usr/bin:/bin` },
      });

      // The 25 tags on HEAD plus the prepared child; the other 225 are history.
      const listed = stdout.split("\n").filter(Boolean);
      assert.lengthOf(listed, 26);
      assert.include(listed, "v1.0.0-nightly.1-fork.1");
      assert.include(listed, "v0.0.0");
      assert.notInclude(listed, "v0.1.0");
      const calls = NodeFS.readFileSync(gitLog, "utf8").split("\n").filter(Boolean).length;
      assert.isAtMost(calls, 4, `expected a batched scan, saw ${calls} git processes`);
    } finally {
      NodeFS.rmSync(scratch, { recursive: true, force: true });
      repo.cleanup();
    }
  });

  it("fails the scan when Git cannot read the tagged commits", () => {
    const repo = createFixtureRepo();
    try {
      tagPreparedChild(repo, "v1.0.0-nightly.1-fork.1", false);
      const binDir = NodePath.join(repo.dir, "fault-bin");
      NodeFS.mkdirSync(binDir);
      const git = NodePath.join(binDir, "git");
      NodeFS.writeFileSync(
        git,
        '#!/bin/sh\nif [ "$1" = rev-list ]; then echo "injected parent lookup failure" >&2; exit 75; fi\nexec /usr/bin/git "$@"\n',
        { mode: 0o755 },
      );
      const result = NodeChildProcess.spawnSync(script, [], {
        cwd: repo.dir,
        encoding: "utf8",
        env: { ...process.env, PATH: `${binDir}:/usr/bin:/bin` },
      });
      assert.equal(result.status, 75, "a failed lookup must not permit a duplicate release");
      assert.equal(result.stdout, "");
      assert.include(result.stderr, "injected parent lookup failure");
    } finally {
      repo.cleanup();
    }
  });

  it("is the only release-tag scan the nightly workflow performs", () => {
    const workflow = NodeFS.readFileSync(
      NodePath.join(repoRoot, ".github/workflows/fork-push-nightly.yml"),
      "utf8",
    );
    assert.include(workflow, 'existing_release_tags="$(scripts/ci/list-release-tags-at-head)"');
    assert.notInclude(workflow, "git tag --list 'v*'");
  });
});
