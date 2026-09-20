// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { assert, describe, it } from "vite-plus/test";
import { createFixtureRepo } from "./lib/git-fixture.ts";

const script = NodeURL.fileURLToPath(new URL("./verify-source", import.meta.url));

describe("verify-source failure collection", () => {
  for (const mode of ["pass", "fail", "knip-fail", "multiple-failures"] as const) {
    it(`handles ${mode} without approving a failing or changed candidate`, () => {
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
if [[ "$*" == 'run typecheck' && ( "$GATE_MODE" == fail || "$GATE_MODE" == multiple-failures ) ]]; then exit 42; fi
if [[ "$*" == 'run knip:check' && ( "$GATE_MODE" == knip-fail || "$GATE_MODE" == multiple-failures ) ]]; then exit 43; fi
if [[ "$*" == *'--parallel'* && "$GATE_MODE" == multiple-failures ]]; then exit 44; fi
`,
        );
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
        assert.include(calls, "run typecheck\n");
        if (mode === "pass") {
          assert.strictEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
          assert.include(calls, "run --filter t3 test --bail=1\n");
        } else if (mode === "knip-fail") {
          assert.strictEqual(result.status, 43);
          assert.include(calls, "run --filter t3 test --bail=1\n");
        } else if (mode === "fail") {
          assert.strictEqual(result.status, 42);
          assert.include(calls, "run --filter t3 test --bail=1\n");
        } else if (mode === "multiple-failures") {
          assert.strictEqual(result.status, 43);
          assert.include(calls, "run --filter t3 test --bail=1\n");
          for (const code of [42, 43, 44]) {
            assert.include(result.stderr, `Verification command failed (exit ${code})`);
          }
        }
      } finally {
        repo.cleanup();
      }
    });
  }
});

describe("verify-stgit-replay promotion gate", () => {
  for (const mode of ["pass", "ci-fail", "stage-fail", "mutate", "policy-fail"]) {
    it(`handles ${mode} before permitting promotion`, () => {
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
          `#!/bin/sh\nexit ${mode === "stage-fail" ? 78 : 0}\n`,
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
        repo.writeFile("tracked.txt", "original\n");
        for (const path of [
          "scripts/ci/check-stgit-stack",
          "scripts/ci/stage-ci-candidate",
          "bin/gh",
        ])
          NodeFS.chmodSync(NodePath.join(repo.dir, path), 0o755);
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
        const names = [
          "Check",
          "Test",
          "Test Server 1",
          "Test Server 2",
          "Test Server 3",
          "Release Smoke",
          "Rust",
          "Fork patch policy",
        ];
        NodeFS.writeFileSync(
          NodePath.join(repo.dir, ".git/jobs.json"),
          JSON.stringify({
            total_count: names.length,
            jobs: names.map((name) => ({
              name,
              status: "completed",
              conclusion: "success",
              labels: ["ubuntu-24.04"],
              steps: [
                name === "Check" ? "Check source" : "Test",
                "Check verified source unchanged",
              ].map((name) => ({ name, status: "completed", conclusion: "success" })),
            })),
          }),
        );
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
        if (mode === "mutate") assert.include(result.stderr, "Verification changed the candidate");
        if (mode === "policy-fail") assert.equal(result.status, 69);
        if (mode === "stage-fail") assert.equal(result.status, 78);
      } finally {
        repo.cleanup();
      }
    });
  }
});
