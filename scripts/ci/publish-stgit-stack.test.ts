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
  readonly remoteBase: string;
  readonly head: string;
  readonly stackOid: string;
  readonly patches: readonly [string, string][];
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
  repo.git("config", "test.leaseMain", remoteBase);
  repo.git("config", "test.leaseStack", stackOid);
  const obsoleteRef = "refs/patches/stgit/adopt/fork-retired";
  repo.git("update-ref", obsoleteRef, remoteBase);
  repo.git(
    "push",
    "origin",
    `${stackRef}:${stackRef}`,
    ...patches.map(([name]) => `refs/patches/stgit/adopt/${name}:refs/patches/stgit/adopt/${name}`),
    `${obsoleteRef}:${obsoleteRef}`,
  );
  repo.git(
    "config",
    "test.leasePatches",
    JSON.stringify(
      Object.fromEntries([
        ...patches.map(([name, oid]) => [`refs/patches/stgit/adopt/${name}`, oid]),
        [obsoleteRef, remoteBase],
      ]),
    ),
  );
  return { repo, remote, remoteBase, head, stackOid, patches, obsoleteRef };
};

const run = (
  repo: FixtureRepo,
  mode: "--check" | "--push",
  env: Readonly<Record<string, string>> = {},
) =>
  NodeChildProcess.spawnSync(script, [mode], {
    cwd: repo.dir,
    encoding: "utf8",
    env: {
      ...process.env,
      SYNC_GIT_BIN: "/usr/bin/git",
      STGIT_EXPECTED_REMOTE_MAIN: repo.git("config", "test.leaseMain"),
      STGIT_EXPECTED_REMOTE_STACK: repo.git("config", "test.leaseStack"),
      STGIT_EXPECTED_PATCH_REFS_JSON: repo.git("config", "test.leasePatches"),
      ...env,
    },
  });

const prepareRelease = (
  fixture: ReturnType<typeof seedPublication>,
): {
  readonly tag: string;
  readonly sha: string;
} => {
  const tree = fixture.repo.git("rev-parse", `${fixture.head}^{tree}`);
  const sha = fixture.repo.git(
    "commit-tree",
    tree,
    "-p",
    fixture.head,
    "-m",
    "chore(release): prepare publication fixture",
  );
  return { tag: "nightly-v0.0.0-test", sha };
};

const remotePatchRefs = (fixture: ReturnType<typeof seedPublication>): string =>
  JSON.stringify(
    Object.fromEntries(
      gitAt(
        fixture.remote,
        "for-each-ref",
        "--format=%(refname) %(objectname)",
        "refs/patches/stgit/adopt",
      )
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          const [ref, oid] = line.split(" ");
          return [ref, oid];
        }),
    ),
  );

const racingGit = (): { readonly bin: string; readonly marker: string; readonly dir: string } => {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-racing-git-"));
  const bin = NodePath.join(dir, "git");
  const marker = NodePath.join(dir, "race-fired");
  NodeFS.writeFileSync(
    bin,
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      'if [[ "${1:-}" == "push" && ! -e "$RACE_MARKER" ]]; then',
      '  : > "$RACE_MARKER"',
      '  /usr/bin/git --git-dir="$RACE_REMOTE" update-ref "$RACE_REF" "$RACE_OID"',
      "fi",
      'exec /usr/bin/git "$@"',
      "",
    ].join("\n"),
  );
  NodeFS.chmodSync(bin, 0o755);
  return { bin, marker, dir };
};

describe("publish-stgit-stack", () => {
  it("rejects publication without preparation-time leases", () => {
    const fixture = seedPublication();
    try {
      const before = gitAt(fixture.remote, "show-ref");
      const result = run(fixture.repo, "--push", {
        STGIT_EXPECTED_REMOTE_MAIN: "",
        STGIT_EXPECTED_REMOTE_STACK: "",
        STGIT_EXPECTED_PATCH_REFS_JSON: "",
      });
      assert.notStrictEqual(result.status, 0);
      assert.strictEqual(gitAt(fixture.remote, "show-ref"), before);
    } finally {
      fixture.repo.cleanup();
      NodeFS.rmSync(fixture.remote, { recursive: true, force: true });
    }
  });

  it("rejects a remote advance that happened before publication started", () => {
    const fixture = seedPublication();
    try {
      const expectedPatches = remotePatchRefs(fixture);
      gitAt(fixture.remote, "update-ref", "refs/heads/main", fixture.patches[0]![1]);
      const before = gitAt(fixture.remote, "show-ref");
      const result = run(fixture.repo, "--push", {
        STGIT_EXPECTED_REMOTE_MAIN: fixture.remoteBase,
        STGIT_EXPECTED_REMOTE_STACK: fixture.stackOid,
        STGIT_EXPECTED_PATCH_REFS_JSON: expectedPatches,
      });
      assert.notStrictEqual(result.status, 0);
      assert.strictEqual(gitAt(fixture.remote, "show-ref"), before);
    } finally {
      fixture.repo.cleanup();
      NodeFS.rmSync(fixture.remote, { recursive: true, force: true });
    }
  });

  it("captures leases once and refuses to renew them after remote metadata changes", () => {
    const fixture = seedPublication();
    try {
      fixture.repo.git("push", "origin", `${fixture.head}:refs/heads/main`);
      fixture.repo.writeFile(
        "scripts/ci/check-stgit-stack",
        `#!/usr/bin/env bash
printf '%s\\n' '${JSON.stringify({ head: fixture.head, patches: fixture.patches.map(([name, oid]) => ({ name, oid })) })}'
`,
      );
      // Keep the fixture clean while providing the same context contract as the real checker.
      fixture.repo.git("update-index", "--assume-unchanged", "scripts/ci/check-stgit-stack");
      const prepare = NodePath.join(repoRoot, "scripts/ci/prepare-stgit-publication");
      const capture = () =>
        NodeChildProcess.spawnSync(prepare, ["--format=json"], {
          cwd: fixture.repo.dir,
          encoding: "utf8",
          env: { ...process.env, SYNC_GIT_BIN: "/usr/bin/git" },
        });
      const first = capture();
      assert.strictEqual(first.status, 0, `${first.stdout}\n${first.stderr}`);
      assert.strictEqual(JSON.parse(first.stdout).head, fixture.head);
      const leasePath = NodePath.join(fixture.repo.dir, ".git/stgit-publication-lease.json");
      const saved = NodeFS.readFileSync(leasePath, "utf8");
      assert.strictEqual(capture().status, 0, "preparation is idempotent on unchanged state");
      gitAt(fixture.remote, "update-ref", "refs/stacks/stgit/adopt", fixture.remoteBase);
      assert.notStrictEqual(capture().status, 0);
      assert.strictEqual(NodeFS.readFileSync(leasePath, "utf8"), saved);
      const before = gitAt(fixture.remote, "show-ref");
      const result = run(fixture.repo, "--push", {
        STGIT_EXPECTED_REMOTE_MAIN: "",
        STGIT_EXPECTED_REMOTE_STACK: "",
        STGIT_EXPECTED_PATCH_REFS_JSON: "",
      });
      assert.notStrictEqual(result.status, 0);
      assert.include(result.stderr, "remote stack lease changed");
      assert.strictEqual(gitAt(fixture.remote, "show-ref"), before);
    } finally {
      fixture.repo.cleanup();
      NodeFS.rmSync(fixture.remote, { recursive: true, force: true });
    }
  });

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
      const history = gitAt(
        fixture.remote,
        "for-each-ref",
        "--format=%(objectname) %(refname)",
        "refs/stack-history/stgit/adopt",
      );
      assert.strictEqual(history.split("\n").length, 2);
      assert.include(history, "-previous");
      for (const line of history.split("\n")) assert.isTrue(line.startsWith(fixture.stackOid));
    } finally {
      fixture.repo.cleanup();
      NodeFS.rmSync(fixture.remote, { recursive: true, force: true });
    }
  });

  it("publishes a prepared tag, bot backup, metadata, and deletions together", () => {
    const fixture = seedPublication();
    try {
      const release = prepareRelease(fixture);
      const result = run(fixture.repo, "--push", {
        STGIT_EXPECTED_REMOTE_MAIN: fixture.remoteBase,
        STGIT_EXPECTED_REMOTE_STACK: fixture.stackOid,
        STGIT_EXPECTED_PATCH_REFS_JSON: remotePatchRefs(fixture),
        STGIT_RELEASE_TAG: release.tag,
        STGIT_RELEASE_TAG_SHA: release.sha,
        STGIT_BACKUP_NAMESPACE: "bot",
      });
      assert.strictEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
      assert.strictEqual(gitAt(fixture.remote, "rev-parse", "refs/heads/main"), fixture.head);
      assert.strictEqual(
        gitAt(fixture.remote, "rev-parse", `refs/tags/${release.tag}`),
        release.sha,
      );
      assert.strictEqual(
        gitAt(fixture.remote, "rev-parse", "refs/stacks/stgit/adopt"),
        fixture.stackOid,
      );
      assert.throws(() => gitAt(fixture.remote, "rev-parse", "--verify", fixture.obsoleteRef));
      assert.include(
        gitAt(fixture.remote, "for-each-ref", "--format=%(refname)", "refs/heads/backup/bot"),
        "refs/heads/backup/bot/stgit-",
      );
    } finally {
      fixture.repo.cleanup();
      NodeFS.rmSync(fixture.remote, { recursive: true, force: true });
    }
  });

  it("rejects a stack that changed after candidate claim without publishing main", () => {
    const fixture = seedPublication();
    try {
      gitAt(fixture.remote, "update-ref", "refs/stacks/stgit/adopt", fixture.remoteBase);
      const result = run(fixture.repo, "--push", {
        STGIT_EXPECTED_REMOTE_MAIN: fixture.remoteBase,
        STGIT_EXPECTED_REMOTE_STACK: fixture.stackOid,
      });
      assert.notStrictEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
      assert.include(result.stderr, "remote stack lease changed");
      assert.strictEqual(gitAt(fixture.remote, "rev-parse", "refs/heads/main"), fixture.remoteBase);
    } finally {
      fixture.repo.cleanup();
      NodeFS.rmSync(fixture.remote, { recursive: true, force: true });
    }
  });

  it("rejects patch-ref set drift after candidate claim without publishing main", () => {
    const fixture = seedPublication();
    try {
      const expected = remotePatchRefs(fixture);
      const [name] = fixture.patches[0]!;
      gitAt(fixture.remote, "update-ref", `refs/patches/stgit/adopt/${name}`, fixture.remoteBase);
      const result = run(fixture.repo, "--push", {
        STGIT_EXPECTED_REMOTE_MAIN: fixture.remoteBase,
        STGIT_EXPECTED_REMOTE_STACK: fixture.stackOid,
        STGIT_EXPECTED_PATCH_REFS_JSON: expected,
      });
      assert.notStrictEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
      assert.include(result.stderr, "remote patch-ref leases changed");
      assert.strictEqual(gitAt(fixture.remote, "rev-parse", "refs/heads/main"), fixture.remoteBase);
    } finally {
      fixture.repo.cleanup();
      NodeFS.rmSync(fixture.remote, { recursive: true, force: true });
    }
  });

  for (const raced of ["main", "tag", "stack", "patch"] as const) {
    it(`rejects a changed ${raced} lease without publishing any other ref`, () => {
      const fixture = seedPublication();
      let wrapper: ReturnType<typeof racingGit> | undefined;
      try {
        const release = prepareRelease(fixture);
        const releaseRef = `refs/tags/${release.tag}`;
        if (raced === "tag") {
          fixture.repo.git("push", "origin", `${fixture.remoteBase}:${releaseRef}`);
        }
        const [firstPatchName, firstPatchOid] = fixture.patches[0]!;
        const race =
          raced === "main"
            ? (["refs/heads/main", firstPatchOid] as const)
            : raced === "tag"
              ? ([releaseRef, firstPatchOid] as const)
              : raced === "stack"
                ? (["refs/stacks/stgit/adopt", fixture.remoteBase] as const)
                : ([`refs/patches/stgit/adopt/${firstPatchName}`, fixture.remoteBase] as const);
        wrapper = racingGit();
        const result = run(fixture.repo, "--push", {
          SYNC_GIT_BIN: wrapper.bin,
          STGIT_EXPECTED_REMOTE_MAIN: fixture.remoteBase,
          STGIT_RELEASE_TAG: release.tag,
          STGIT_RELEASE_TAG_SHA: release.sha,
          STGIT_BACKUP_NAMESPACE: "bot",
          RACE_MARKER: wrapper.marker,
          RACE_REMOTE: fixture.remote,
          RACE_REF: race[0],
          RACE_OID: race[1],
        });
        assert.notStrictEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
        assert.strictEqual(NodeFS.existsSync(wrapper.marker), true);
        if (raced !== "main") {
          assert.strictEqual(
            gitAt(fixture.remote, "rev-parse", "refs/heads/main"),
            fixture.remoteBase,
          );
        }
        if (raced !== "tag") {
          assert.throws(() => gitAt(fixture.remote, "rev-parse", "--verify", releaseRef));
        }
        assert.strictEqual(
          gitAt(fixture.remote, "rev-parse", fixture.obsoleteRef),
          fixture.remoteBase,
        );
        assert.strictEqual(
          gitAt(fixture.remote, "for-each-ref", "--format=%(refname)", "refs/heads/backup/bot"),
          "",
        );
      } finally {
        fixture.repo.cleanup();
        NodeFS.rmSync(fixture.remote, { recursive: true, force: true });
        if (wrapper) NodeFS.rmSync(wrapper.dir, { recursive: true, force: true });
      }
    });
  }
});
