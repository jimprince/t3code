// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { assert, describe, it } from "@effect/vitest";
import { createFixtureRepo } from "./lib/git-fixture.ts";
import {
  integrateConcerns,
  integrationContract,
  validateIntegrationPlan,
  type IntegrationConcern,
} from "./lib/stgit-integration.ts";

const repoRoot = NodePath.resolve(
  NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
  "../..",
);
const script = NodePath.join(repoRoot, "scripts/ci/integrate-stgit-concerns");

const sha = (digit: string): string => digit.repeat(40);
const refreshConcern = (digit: string, owner = "fork-one"): IntegrationConcern => ({
  kind: "refresh",
  candidate: sha(digit),
  repo: undefined,
  owner,
});

describe("StGit integration plan", () => {
  it("accepts refresh and new concerns and rejects duplicates", () => {
    const newConcern = {
      candidate: sha("2"),
      patch: {
        name: "fork-new",
        subject: "feat: new",
        class: "product",
        purpose: "p",
        retireWhen: "never",
        dependsOn: ["fork-one"],
      },
    };
    const plan = validateIntegrationPlan({
      contract: integrationContract,
      concerns: [{ candidate: sha("1"), owner: "fork-one" }, newConcern],
    });
    assert.deepEqual(
      plan.concerns.map(({ kind }) => kind),
      ["refresh", "new"],
    );
    assert.throws(() =>
      validateIntegrationPlan({
        contract: integrationContract,
        concerns: [
          { candidate: sha("1"), owner: "fork-one" },
          { candidate: sha("1"), owner: "fork-two" },
        ],
      }),
    );
    assert.throws(() =>
      validateIntegrationPlan({
        contract: integrationContract,
        concerns: [newConcern, { ...newConcern, candidate: sha("3") }],
      }),
    );
    assert.throws(() =>
      validateIntegrationPlan({
        contract: integrationContract,
        concerns: [{ candidate: sha("1"), owner: "fork-one", patch: newConcern.patch }],
      }),
    );
  });
});

describe("integrateConcerns", () => {
  it("rolls back and reports a failing concern while applying the rest in order", () => {
    const events: string[] = [];
    const outcomes = integrateConcerns(
      [refreshConcern("1"), refreshConcern("2"), refreshConcern("3")],
      {
        apply: (concern) => {
          events.push(`apply ${concern.candidate[0]}`);
          if (concern.candidate === sha("2")) throw new Error("conflict");
        },
        check: () => events.push("check"),
        rollback: () => events.push("rollback"),
      },
    );
    assert.deepEqual(events, ["apply 1", "check", "apply 2", "rollback", "apply 3", "check"]);
    assert.deepEqual(
      outcomes.map((outcome) => outcome.status),
      ["applied", "skipped", "applied"],
    );
  });

  it("skips a concern whose stack check fails", () => {
    const outcomes = integrateConcerns([refreshConcern("1")], {
      apply: () => undefined,
      check: () => {
        throw new Error("stack invalid");
      },
      rollback: () => undefined,
    });
    assert.strictEqual(outcomes[0]?.status, "skipped");
  });
});

const stgAvailable =
  NodeChildProcess.spawnSync("stg", ["--version"], { encoding: "utf8" }).status === 0;

const bash = (cwd: string, command: string): string =>
  NodeChildProcess.execFileSync("bash", ["-ec", command], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, PATH: `/usr/bin:${process.env.PATH ?? ""}`, HUSKY: "0" },
  }).trim();

const stanza = (name: string, dependsOn: readonly string[], roles: readonly string[]): string =>
  [
    "[[patch]]",
    `name = ${JSON.stringify(name)}`,
    `subject = ${JSON.stringify(`feat: ${name}`)}`,
    'class = "product"',
    `purpose = ${JSON.stringify(`Own ${name}.`)}`,
    'retire_when = "never"',
    `depends_on = ${JSON.stringify(dependsOn)}`,
    `roles = ${JSON.stringify(roles)}`,
    "",
  ].join("\n");

describe.skipIf(!stgAvailable)("integrate-stgit-concerns with real StGit", () => {
  const buildRemote = () => {
    const repo = createFixtureRepo();
    NodeFS.cpSync(NodePath.join(repoRoot, "scripts/ci"), NodePath.join(repo.dir, "scripts/ci"), {
      recursive: true,
    });
    repo.writeFile("scripts/ci/check-fork-docs.ts", "process.exit(0);\n");
    repo.writeFile("docs/operations/fork-inventory.toml", "schema = 2\n\n");
    repo.writeFile("one.txt", "base\n");
    repo.commitAll("chore: base");
    repo.git("switch", "-c", "stgit/adopt");
    bash(repo.dir, "stg init");
    let inventory = "schema = 2\n\n";
    let previous: string[] = [];
    const roles = {
      "fork-one": ["lockfile-owner", "release-workflow-owner"],
      "fork-two": ["agent-docs-owner"],
    };
    for (const name of ["fork-one", "fork-two"] as const) {
      bash(repo.dir, `stg new ${name} --message 'feat: ${name}'`);
      inventory += stanza(name, previous, roles[name]);
      previous = [name];
      repo.writeFile("docs/operations/fork-inventory.toml", inventory);
      repo.writeFile(`${name}.txt`, `${name}\n`);
      repo.git("add", "--", "docs/operations/fork-inventory.toml", `${name}.txt`);
      bash(repo.dir, "stg refresh --index");
    }
    const remote = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-integrate-remote-"));
    bash(remote, "git init --bare -b main .");
    repo.git("push", remote, "HEAD:refs/heads/main");
    repo.git(
      "push",
      remote,
      "+refs/stacks/stgit/adopt:refs/stacks/stgit/adopt",
      "+refs/patches/stgit/adopt/*:refs/patches/stgit/adopt/*",
    );
    return { repo, remote };
  };

  it("batches a refresh, a conflicting refresh and a new concern under one lease claim", () => {
    const { repo, remote } = buildRemote();
    const work = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-integrate-work-"));
    try {
      const base = remoteMain(remote);
      const makeCandidate = (file: string, text: string): string => {
        repo.git("switch", "--detach", base);
        repo.writeFile(file, text);
        const oid = repo.commitAll(`change ${file}`);
        repo.git("switch", "stgit/adopt");
        return oid;
      };
      const refreshOne = makeCandidate("fork-one.txt", "fork-one\nrefreshed\n");
      const conflicting = makeCandidate("fork-one.txt", "fork-one\nconflicting\n");
      const brand = makeCandidate("three.txt", "three\n");
      const planPath = NodePath.join(work, "plan.json");
      NodeFS.writeFileSync(
        planPath,
        JSON.stringify({
          contract: integrationContract,
          concerns: [
            { candidate: refreshOne, repo: repo.dir, owner: "fork-one" },
            { candidate: conflicting, repo: repo.dir, owner: "fork-one" },
            {
              candidate: brand,
              repo: repo.dir,
              patch: {
                name: "fork-three",
                subject: "feat: three",
                class: "product",
                purpose: "Third concern",
                retireWhen: "never",
                dependsOn: ["fork-two"],
              },
            },
          ],
        }),
      );
      const output = NodePath.join(work, "clone");
      const stdout = NodeChildProcess.execFileSync(
        script,
        ["--plan", planPath, "--output", output, "--remote", remote, "--expected-main", base],
        {
          cwd: repo.dir,
          encoding: "utf8",
          env: { ...process.env, SYNC_GIT_BIN: "/usr/bin/git", HUSKY: "0" },
        },
      );
      const result = JSON.parse(stdout) as {
        applied: string[];
        skipped: { candidate: string }[];
      };
      assert.deepEqual(result.applied, [refreshOne, brand]);
      assert.deepEqual(
        result.skipped.map(({ candidate: skipped }) => skipped),
        [conflicting],
      );
      assert.deepEqual(bash(output, "stg series --applied --noprefix").split("\n"), [
        "fork-one",
        "fork-two",
        "fork-three",
      ]);
      assert.strictEqual(bash(output, "git status --porcelain"), "");
      assert.include(bash(output, "cat fork-one.txt"), "refreshed");
      assert.notInclude(bash(output, "cat fork-one.txt"), "conflicting");
      assert.strictEqual(bash(output, "cat three.txt"), "three");
      assert.include(
        bash(output, "cat docs/operations/fork-inventory.toml"),
        'name = "fork-three"',
      );
      const leases = JSON.parse(
        NodeFS.readFileSync(NodePath.join(output, ".git/stgit-publication-lease.json"), "utf8"),
      ) as { main: string };
      assert.strictEqual(leases.main, base);
    } finally {
      NodeFS.rmSync(work, { recursive: true, force: true });
      NodeFS.rmSync(remote, { recursive: true, force: true });
      repo.cleanup();
    }
  });
});

const remoteMain = (remote: string): string =>
  NodeChildProcess.execFileSync("/usr/bin/git", ["rev-parse", "refs/heads/main"], {
    cwd: remote,
    encoding: "utf8",
  }).trim();
