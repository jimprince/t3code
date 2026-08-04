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
const script = NodePath.join(repoRoot, "scripts/ci/check-stgit-stack");

type PatchSeed = {
  readonly name: string;
  readonly subject: string;
  readonly roles?: readonly string[];
  readonly addInventory?: boolean;
};

const stanza = (patch: PatchSeed, dependsOn: readonly string[]): string =>
  [
    "[[patch]]",
    `name = ${JSON.stringify(patch.name)}`,
    `subject = ${JSON.stringify(patch.subject)}`,
    'class = "product"',
    `purpose = ${JSON.stringify(`Own ${patch.name}.`)}`,
    'retire_when = "never"',
    `depends_on = ${JSON.stringify(dependsOn)}`,
    `roles = ${JSON.stringify(patch.roles ?? [])}`,
    "",
  ].join("\n");

const writeStack = (
  repo: FixtureRepo,
  patches: readonly [string, string][],
  head = repo.git("rev-parse", "HEAD"),
): void => {
  const stackRef = "refs/stacks/stgit/adopt";
  const payload = JSON.stringify({
    version: 5,
    prev: repo.git("rev-parse", `${patches[0]?.[1] ?? head}^`),
    head,
    applied: patches.map(([name]) => name),
    unapplied: [],
    hidden: [],
    patches: Object.fromEntries(patches.map(([name, oid]) => [name, { oid }])),
  });
  const blob = NodeChildProcess.execFileSync("/usr/bin/git", ["hash-object", "-w", "--stdin"], {
    cwd: repo.dir,
    input: payload,
    encoding: "utf8",
  }).trim();
  const tree = NodeChildProcess.execFileSync("/usr/bin/git", ["mktree"], {
    cwd: repo.dir,
    input: `100644 blob ${blob}\tstack.json\n`,
    encoding: "utf8",
  }).trim();
  const commit = repo.git("commit-tree", tree, "-p", head);
  repo.git("update-ref", stackRef, commit);
  for (const [name, oid] of patches)
    repo.git("update-ref", `refs/patches/stgit/adopt/${name}`, oid);
};

const seedStack = (
  repo: FixtureRepo,
  patches: readonly PatchSeed[],
): readonly [string, string][] => {
  let inventory = "schema = 2\n\n";
  const commits: [string, string][] = [];
  const previous: string[] = [];
  for (const patch of patches) {
    repo.writeFile("shared.txt", `${patch.name}\n`);
    if (patch.addInventory !== false) {
      inventory += stanza(patch, previous.length === 0 ? [] : [previous.at(-1)!]);
      repo.writeFile("docs/operations/fork-inventory.toml", inventory);
    }
    const oid = repo.commitAll(patch.subject);
    commits.push([patch.name, oid]);
    previous.push(patch.name);
  }
  writeStack(repo, commits);
  return commits;
};

const run = (repo: FixtureRepo): { readonly status: number; readonly output: string } => {
  const result = NodeChildProcess.spawnSync(script, [], {
    cwd: repo.dir,
    encoding: "utf8",
    env: {
      ...process.env,
      STGIT_INVENTORY: "docs/operations/fork-inventory.toml",
      STGIT_METADATA_REF: "refs/stacks/stgit/adopt",
      SYNC_GIT_BIN: "/usr/bin/git",
    },
  });
  return { status: result.status ?? 1, output: `${result.stdout}${result.stderr}` };
};

const validPatches = [
  {
    name: "fork-stgit-stack-policy",
    subject: "docs(fork): define StGit stack policy",
    roles: ["agent-docs-owner"],
  },
  {
    name: "fork-build-workspace-tooling",
    subject: "build(fork): configure workspace tooling",
    roles: ["lockfile-owner"],
  },
  {
    name: "fork-ci-release-pipeline",
    subject: "ci(fork): publish releases",
    roles: ["release-workflow-owner"],
  },
] as const;

describe("check-stgit-stack", () => {
  it("accepts an ordered inventory even when every patch edits the same file", () => {
    const repo = createFixtureRepo();
    try {
      seedStack(repo, validPatches);
      const result = run(repo);
      assert.strictEqual(result.status, 0, result.output);
      assert.include(result.output, "3 applied patches");
    } finally {
      repo.cleanup();
    }
  });

  it("rejects a patch that did not add its own inventory stanza", () => {
    const repo = createFixtureRepo();
    try {
      seedStack(repo, [
        validPatches[0],
        { ...validPatches[1], addInventory: false },
        validPatches[2],
      ]);
      const result = run(repo);
      assert.notStrictEqual(result.status, 0);
      assert.include(result.output, "inventory");
    } finally {
      repo.cleanup();
    }
  });

  it("rejects duplicate singleton operational roles", () => {
    const repo = createFixtureRepo();
    try {
      seedStack(repo, [
        validPatches[0],
        validPatches[1],
        { ...validPatches[2], roles: ["release-workflow-owner", "lockfile-owner"] },
      ]);
      const result = run(repo);
      assert.notStrictEqual(result.status, 0);
      assert.include(result.output, "lockfile-owner");
    } finally {
      repo.cleanup();
    }
  });

  it("rejects metadata whose recorded head differs from HEAD", () => {
    const repo = createFixtureRepo();
    try {
      const commits = seedStack(repo, validPatches);
      writeStack(repo, commits, repo.git("rev-parse", "HEAD^"));
      const result = run(repo);
      assert.notStrictEqual(result.status, 0);
      assert.include(result.output, "stack.json.head");
    } finally {
      repo.cleanup();
    }
  });
});
