// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { assert, describe, it } from "@effect/vitest";
import { createFixtureRepo } from "./lib/git-fixture.ts";

const script = NodeURL.fileURLToPath(new URL("./verify-stgit-replay", import.meta.url));

describe("verify-stgit-replay", () => {
  for (const mode of [
    "pass",
    "fail",
    "knip-fail",
    "multiple-failures",
    "install-fail",
    "mutate",
  ] as const) {
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
if [[ "$*" == 'install --frozen-lockfile' && "$GATE_MODE" == install-fail ]]; then exit 45; fi
if [[ "$*" == 'run typecheck' && ( "$GATE_MODE" == fail || "$GATE_MODE" == multiple-failures ) ]]; then exit 42; fi
if [[ "$*" == 'run knip:check' && ( "$GATE_MODE" == knip-fail || "$GATE_MODE" == multiple-failures ) ]]; then exit 43; fi
if [[ "$*" == *'--parallel'* && "$GATE_MODE" == multiple-failures ]]; then exit 44; fi
if [[ "$*" == 'run --filter t3 test --bail=1' && "$GATE_MODE" == mutate ]]; then echo changed > tracked.txt; fi
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
        if (mode !== "install-fail") assert.include(calls, "run typecheck\n");
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
        } else if (mode === "install-fail") {
          assert.strictEqual(result.status, 45);
          assert.notInclude(calls, "run typecheck\n");
          assert.notInclude(calls, "run --filter t3 test --bail=1\n");
        } else {
          assert.notStrictEqual(result.status, 0);
          assert.include(result.stderr, "Verification changed the candidate");
        }
      } finally {
        repo.cleanup();
      }
    });
  }
});
