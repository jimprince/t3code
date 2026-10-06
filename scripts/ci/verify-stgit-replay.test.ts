// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { assert, describe, it } from "vite-plus/test";
import { createFixtureRepo } from "./lib/git-fixture.ts";
import { candidateJobSteps, candidateJobs } from "./reuse-release-ci.ts";

const script = NodeURL.fileURLToPath(new URL("./verify-source", import.meta.url));
// Complete candidate evidence: every expected job green on the expected runner.
const jobs = () => ({
  total_count: candidateJobs.length,
  jobs: candidateJobs.map((name) => ({
    name,
    status: "completed",
    conclusion: "success",
    labels: ["ubuntu-24.04"],
    steps: candidateJobSteps(name).map((step) => ({
      name: step,
      status: "completed",
      conclusion: "success",
    })),
  })),
});

describe("verify-source workspace typechecks", () => {
  it.each(["pass", "group-fail", "scripts-fail", "group-and-scripts-fail"] as const)(
    "runs real Vite+ tasks and collects %s",
    (mode) => {
      const repo = createFixtureRepo();
      try {
        const cli = NodeURL.fileURLToPath(
          new URL(
            "./bin/vp",
            NodeURL.pathToFileURL(
              NodeModule.createRequire(import.meta.url).resolve("vite-plus/package.json"),
            ),
          ),
        );
        repo.writeFile(
          "bin/vp",
          `#!/usr/bin/env node
const { spawnSync } = require("node:child_process");
const result = spawnSync(process.execPath, [${JSON.stringify(cli)}, ...process.argv.slice(2)], { stdio: "inherit" });
process.exit(result.status ?? 1);
`,
        );
        NodeFS.chmodSync(NodePath.join(repo.dir, "bin/vp"), 0o755);
        repo.writeFile("pnpm-workspace.yaml", 'packages: ["packages/*"]\n');
        repo.writeFile(
          "package.json",
          JSON.stringify({
            name: "@t3tools/monorepo",
            private: true,
            scripts: { typecheck: "node record.cjs root typecheck" },
          }),
        );
        repo.writeFile(
          "record.cjs",
          `const fs = require("node:fs");
const [name, task] = process.argv.slice(2);
fs.appendFileSync(process.env.CALL_LOG, name + " " + task + "\\n");
if (name === "root") process.exit(99);
if (task === "typecheck" && process.env.GATE_MODE.startsWith("group-") && name === "@t3tools/shared") process.exit(42);
if (task === "typecheck" && process.env.GATE_MODE.endsWith("scripts-fail") && name === "@t3tools/scripts") process.exit(45);
`,
        );
        const workspaces = [
          "@t3tools/desktop",
          "@t3tools/shared",
          "@t3tools/web",
          "t3",
          "@t3tools/scripts",
          "t3code-relay",
          "@t3tools/oxlint-plugin-t3code",
        ];
        for (const [index, name] of workspaces.entries()) {
          repo.writeFile(
            `packages/workspace-${index}/package.json`,
            JSON.stringify({
              name,
              private: true,
              scripts: {
                typecheck: `node ../../record.cjs ${name} typecheck`,
                "ensure:electron": `node ../../record.cjs ${name} ensure:electron`,
              },
            }),
          );
        }
        const log = NodePath.join(repo.dir, ".git/typecheck-calls");
        const result = NodeChildProcess.spawnSync(script, ["typecheck"], {
          cwd: repo.dir,
          encoding: "utf8",
          env: {
            ...process.env,
            PATH: `${repo.dir}/bin:${process.env.PATH}`,
            CALL_LOG: log,
            GATE_MODE: mode,
          },
        });
        const calls = NodeFS.readFileSync(log, "utf8").trim().split("\n");
        const diagnostics = `${result.stdout}\n${result.stderr}`;
        if (mode === "pass" || mode === "scripts-fail") {
          assert.strictEqual(result.status, mode === "pass" ? 0 : 45, diagnostics);
        } else {
          // Vite+ may normalize a failed task's status to 1 for a workspace group.
          assert.isAbove(result.status ?? 0, 0, diagnostics);
          assert.include(calls, "@t3tools/shared typecheck");
          assert.include(result.stderr, "): vp run --concurrency-limit 2 ");
        }
        assert.include(calls, "@t3tools/desktop ensure:electron");
        assert.notInclude(calls, "root typecheck");
        for (const workspace of workspaces.slice(4)) {
          assert.strictEqual(calls.filter((call) => call === `${workspace} typecheck`).length, 1);
        }
        if (mode === "pass" || mode === "scripts-fail") {
          for (const workspace of workspaces) {
            assert.strictEqual(calls.filter((call) => call === `${workspace} typecheck`).length, 1);
          }
        }
        if (mode !== "pass") {
          assert.include(result.stderr, "Verification command failed");
        }
        if (mode === "group-and-scripts-fail") {
          assert.include(result.stderr, "): vp run --filter @t3tools/scripts typecheck");
          const firstFailure = result.stderr.match(/Verification command failed \(exit (\d+)\)/);
          assert.isNotNull(firstFailure, diagnostics);
          assert.strictEqual(result.status, Number(firstFailure?.[1]), diagnostics);
        }
      } finally {
        repo.cleanup();
      }
    },
  );
});

describe("verify-source failure collection", () => {
  it.each(["pass", "fail", "knip-fail", "scripts-fail", "multiple-failures"] as const)(
    "handles %s without approving a failing or changed candidate",
    (mode) => {
      const repo = createFixtureRepo();
      try {
        repo.writeFile(
          "scripts/ci/verify-source",
          NodeFS.readFileSync(new URL("./verify-source", import.meta.url), "utf8"),
        );
        repo.writeFile("scripts/ci/check-stgit-stack", "#!/usr/bin/env bash\nexit 0\n");
        repo.writeFile("scripts/ci/check-fork-docs.ts", "process.exit(0);\n");
        repo.writeFile("scripts/ci/check-fork-release-notes.ts", "process.exit(0);\n");
        repo.writeFile(
          "bin/vp",
          `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$CALL_LOG"
if [[ "$*" == 'run --concurrency-limit 2'*' typecheck' && ( "$GATE_MODE" == fail || "$GATE_MODE" == multiple-failures ) ]]; then exit 42; fi
if [[ "$*" == 'run knip:check' && ( "$GATE_MODE" == knip-fail || "$GATE_MODE" == multiple-failures ) ]]; then exit 43; fi
if [[ "$*" == *'--parallel'* && "$GATE_MODE" == multiple-failures ]]; then exit 44; fi
if [[ "$*" == 'run --filter @t3tools/scripts test' && ( "$GATE_MODE" == scripts-fail || "$GATE_MODE" == multiple-failures ) ]]; then exit 45; fi
`,
        );
        repo.writeFile("apps/server/node_modules/playwright-core/cli.js", "process.exit(0);\n");
        repo.writeFile(".github/scripts/stage-preview-bundle.test.py", "pass\n");
        repo.writeFile(".github/scripts/check-nightly-release.test.cjs", "\n");
        repo.writeFile("apps/desktop/scripts/verify-preload-bundle.mjs", "\n");
        repo.writeFile("scripts/release-smoke.ts", "\n");
        repo.writeFile("tracked.txt", "original\n");
        for (const file of ["scripts/ci/check-stgit-stack", "bin/vp", "scripts/ci/verify-source"])
          NodeFS.chmodSync(NodePath.join(repo.dir, file), 0o755);
        repo.commitAll("test: gate fixture");
        const head = repo.git("rev-parse", "HEAD");
        const log = NodePath.join(repo.dir, ".git/gate-calls");
        const result = NodeChildProcess.spawnSync(script, [], {
          cwd: repo.dir,
          encoding: "utf8",
          env: {
            ...process.env,
            PATH: `${repo.dir}/bin:/usr/bin:${process.env.PATH}`,
            CALL_LOG: log,
            GATE_MODE: mode,
          },
        });
        assert.strictEqual(repo.git("rev-parse", "HEAD"), head);
        const calls = NodeFS.readFileSync(log, "utf8");
        assert.include(calls, "run --concurrency-limit 2");
        for (const workspace of [
          "@t3tools/scripts",
          "t3code-relay",
          "@t3tools/oxlint-plugin-t3code",
        ]) {
          assert.include(calls, `run --filter ${workspace} typecheck\n`);
          assert.include(calls, `run --filter ${workspace} test\n`);
        }
        if (mode === "pass") {
          assert.strictEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
          assert.include(calls, "run --filter t3 test --bail=1\n");
          assert.include(calls, "run --filter @t3tools/web test\n");
        } else if (mode === "knip-fail") {
          assert.strictEqual(result.status, 43);
          assert.include(calls, "run --filter t3 test --bail=1\n");
        } else if (mode === "fail") {
          assert.strictEqual(result.status, 42);
          assert.include(calls, "run --filter t3 test --bail=1\n");
        } else if (mode === "scripts-fail") {
          assert.strictEqual(result.status, 45);
          assert.include(calls, "run --filter t3 test --bail=1\n");
        } else if (mode === "multiple-failures") {
          assert.strictEqual(result.status, 43);
          assert.include(calls, "run --filter t3 test --bail=1\n");
          for (const code of [42, 43, 44, 45]) {
            assert.include(result.stderr, `Verification command failed (exit ${code})`);
          }
        }
      } finally {
        repo.cleanup();
      }
    },
  );
});

// Stands in for vp: records calls and fails the pre-check the mode names.
const vpStub = `#!/bin/sh
printf '%s\\n' "$*" >> .git/vp-calls
if [ "$*" = 'run knip:check' ] && [ "$GATE_MODE" = knip-fail ]; then exit 43; fi
case "$*" in 'fmt --check'*) if [ "$GATE_MODE" = format-fail ]; then exit 44; fi ;; esac
exit 0
`;

describe("verify-stgit-replay promotion gate", () => {
  it.each(["pass", "ci-fail", "stage-fail", "mutate", "policy-fail", "knip-fail", "format-fail"])(
    "handles %s before permitting promotion",
    (mode) => {
      const repo = createFixtureRepo();
      try {
        repo.writeFile(
          "scripts/ci/check-stgit-stack",
          `#!/bin/sh\nexit ${mode === "policy-fail" ? 69 : 0}\n`,
        );
        repo.writeFile("scripts/ci/check-fork-docs.ts", "process.exit(0);\n");
        repo.writeFile("scripts/ci/check-fork-release-notes.ts", "process.exit(0);\n");
        repo.writeFile(
          "scripts/ci/stage-ci-candidate",
          `#!/bin/sh\n: > .git/staged\nexit ${mode === "stage-fail" ? 78 : 0}\n`,
        );
        repo.writeFile(
          "scripts/ci/reuse-release-ci.ts",
          NodeFS.readFileSync(new URL("./reuse-release-ci.ts", import.meta.url), "utf8"),
        );
        repo.writeFile(
          "bin/gh",
          `#!/bin/sh
if [ "$GATE_MODE" = mutate ]; then echo changed > tracked.txt; fi
case "$2" in
  */jobs*) cat .git/jobs.json ;;
  *) cat .git/run.json ;;
esac
`,
        );
        repo.writeFile("bin/vp", vpStub);
        repo.writeFile("tracked.txt", "original\n");
        for (const path of [
          "scripts/ci/check-stgit-stack",
          "scripts/ci/stage-ci-candidate",
          "bin/gh",
          "bin/vp",
        ])
          NodeFS.chmodSync(NodePath.join(repo.dir, path), 0o755);
        repo.git("update-ref", "refs/remotes/origin/main", repo.git("rev-parse", "HEAD"));
        const head = repo.commitAll("gate fixture");
        NodeFS.writeFileSync(
          NodePath.join(repo.dir, ".git/run.json"),
          JSON.stringify({
            workflow_runs: [
              {
                id: 42,
                run_attempt: 1,
                head_sha: head,
                head_branch: `ci-candidate/${head}`,
                event: "push",
                path: ".github/workflows/ci.yml",
                repository: { full_name: "owner/fork" },
                status: "completed",
                conclusion: mode === "ci-fail" ? "failure" : "success",
              },
            ],
          }),
        );
        NodeFS.writeFileSync(NodePath.join(repo.dir, ".git/jobs.json"), JSON.stringify(jobs()));
        const result = NodeChildProcess.spawnSync(
          NodeURL.fileURLToPath(new URL("./verify-stgit-replay", import.meta.url)),
          [],
          {
            cwd: repo.dir,
            encoding: "utf8",
            env: {
              ...process.env,
              PATH: `${repo.dir}/bin:/usr/bin:${process.env.PATH}`,
              GITHUB_REPOSITORY: "owner/fork",
              GATE_MODE: mode,
            },
          },
        );
        assert.equal(repo.git("rev-parse", "HEAD"), head);
        if (mode === "pass") assert.equal(result.status, 0, result.stderr);
        else assert.notEqual(result.status, 0, `${mode} must block promotion`);
        const vpCalls = NodeFS.existsSync(NodePath.join(repo.dir, ".git/vp-calls"))
          ? NodeFS.readFileSync(NodePath.join(repo.dir, ".git/vp-calls"), "utf8")
          : "";
        const staged = NodeFS.existsSync(NodePath.join(repo.dir, ".git/staged"));
        if (mode === "pass") {
          assert.include(vpCalls, "install --frozen-lockfile\n");
          assert.include(vpCalls, "run knip:check\n");
          assert.match(vpCalls, /fmt --check --no-error-on-unmatched-pattern -- .*tracked\.txt/);
        }
        if (mode === "knip-fail") {
          assert.equal(result.status, 43);
          assert.notInclude(vpCalls, "fmt --check");
        }
        if (mode === "format-fail") assert.equal(result.status, 44);
        if (mode === "knip-fail" || mode === "format-fail")
          assert.isFalse(staged, "a failed pre-check must not spend a candidate CI round");
        if (mode === "mutate") assert.include(result.stderr, "Verification changed the candidate");
        if (mode === "policy-fail") assert.equal(result.status, 69);
        if (mode === "stage-fail") assert.equal(result.status, 78);
      } finally {
        repo.cleanup();
      }
    },
  );
});

describe("verify-stgit-replay candidate evidence repository", () => {
  it("reads evidence from the staging remote, not a bare gh repo lookup", () => {
    const repo = createFixtureRepo();
    try {
      repo.git("remote", "add", "origin", "https://github.com/owner/fork.git");
      // The replay driver adds this remote, and a bare `gh repo view` prefers it.
      repo.git("remote", "add", "upstream", "https://github.com/other/upstream.git");
      repo.writeFile("scripts/ci/check-stgit-stack", "#!/bin/sh\nexit 0\n");
      repo.writeFile("scripts/ci/check-fork-docs.ts", "process.exit(0);\n");
      repo.writeFile("scripts/ci/check-fork-release-notes.ts", "process.exit(0);\n");
      repo.writeFile("scripts/ci/stage-ci-candidate", "#!/bin/sh\nexit 0\n");
      repo.writeFile(
        "scripts/ci/reuse-release-ci.ts",
        NodeFS.readFileSync(new URL("./reuse-release-ci.ts", import.meta.url), "utf8"),
      );
      repo.writeFile(
        "bin/gh",
        `#!/bin/sh
case "$1" in
  repo)
    case "$3" in
      *owner/fork*) echo owner/fork ;;
      *) echo other/upstream ;;
    esac
    ;;
  *)
    printf '%s\\n' "$2" >> .git/gh-api
    case "$2" in
      */jobs*) cat .git/jobs.json ;;
      *) cat .git/run.json ;;
    esac
    ;;
esac
`,
      );
      repo.writeFile("bin/vp", vpStub);
      for (const path of [
        "scripts/ci/check-stgit-stack",
        "scripts/ci/stage-ci-candidate",
        "bin/gh",
        "bin/vp",
      ])
        NodeFS.chmodSync(NodePath.join(repo.dir, path), 0o755);
      repo.git("update-ref", "refs/remotes/origin/main", repo.git("rev-parse", "HEAD"));
      const head = repo.commitAll("gate fixture");
      NodeFS.writeFileSync(
        NodePath.join(repo.dir, ".git/run.json"),
        JSON.stringify({
          workflow_runs: [
            {
              id: 42,
              run_attempt: 1,
              head_sha: head,
              head_branch: `ci-candidate/${head}`,
              event: "push",
              path: ".github/workflows/ci.yml",
              repository: { full_name: "owner/fork" },
              status: "completed",
              conclusion: "success",
            },
          ],
        }),
      );
      NodeFS.writeFileSync(NodePath.join(repo.dir, ".git/jobs.json"), JSON.stringify(jobs()));
      const env: Record<string, string | undefined> = {
        ...process.env,
        PATH: `${repo.dir}/bin:/usr/bin:${process.env.PATH}`,
      };
      // Actions sets this for its own runs; the fallback is what is under test.
      delete env.GITHUB_REPOSITORY;
      const result = NodeChildProcess.spawnSync(
        NodeURL.fileURLToPath(new URL("./verify-stgit-replay", import.meta.url)),
        [],
        { cwd: repo.dir, encoding: "utf8", env },
      );
      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
      const queried = NodeFS.readFileSync(NodePath.join(repo.dir, ".git/gh-api"), "utf8");
      assert.include(queried, "repos/owner/fork/");
      assert.notInclude(queried, "other/upstream");
    } finally {
      repo.cleanup();
    }
  });
});
