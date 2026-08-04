// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { assert, describe, it } from "@effect/vitest";
import { createFixtureRepo } from "./lib/git-fixture.ts";

const script = NodeURL.fileURLToPath(new URL("./verify-stgit-replay", import.meta.url));

describe("verify-stgit-replay", () => {
  for (const mode of ["pass", "fail", "mutate"] as const) {
    it(`handles ${mode} without approving a failing or changed candidate`, () => {
      const repo = createFixtureRepo();
      try {
        repo.writeFile("scripts/ci/check-stgit-stack", "#!/usr/bin/env bash\nexit 0\n");
        repo.writeFile("scripts/ci/check-fork-docs.ts", "process.exit(0);\n");
        repo.writeFile(
          "bin/vp",
          `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$CALL_LOG"
if [[ "$*" == 'run typecheck' && "$GATE_MODE" == fail ]]; then exit 42; fi
if [[ "$*" == 'run test' && "$GATE_MODE" == mutate ]]; then echo changed > tracked.txt; fi
`,
        );
        repo.writeFile("tracked.txt", "original\n");
        for (const file of ["scripts/ci/check-stgit-stack", "bin/vp"])
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
          assert.include(calls, "run test\n");
        } else if (mode === "fail") {
          assert.strictEqual(result.status, 42);
          assert.notInclude(calls, "run test\n");
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
