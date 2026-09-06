// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodePath from "node:path";
import { assert, describe, it } from "vite-plus/test";
import { createFixtureRepo } from "./lib/git-fixture.ts";

const script = NodePath.resolve(import.meta.dirname, "report-nightly-delivery");

describe("nightly delivery receipts", () => {
  it("binds CI and release to the exact peeled tag and source, rejecting moved tags", () => {
    const repo = createFixtureRepo();
    try {
      const base = repo.git("rev-parse", "HEAD");
      const tag = "v0.0.43-nightly.20260920.2005";
      repo.git("tag", "-a", tag, "-m", "upstream nightly");
      repo.writeFile("feature.txt", "fork\n");
      const source = repo.commitAll("feat: fork");
      const run = (...args: string[]) =>
        NodeChildProcess.spawnSync(script, args, {
          cwd: repo.dir,
          encoding: "utf8",
          env: { ...process.env, NIGHTLY_UPSTREAM_URL: repo.dir },
        });
      for (const args of [
        [base, source],
        [base, source, tag],
        ["", source, tag, `${tag}-fork.2`],
      ]) {
        const result = run(...args);
        assert.equal(result.status, 0, result.stderr);
        const marker = JSON.parse(result.stdout.trim().split("CI_REPAIR_BOT_NIGHTLY=")[1]!);
        assert.equal(marker.target, tag);
        assert.equal(marker.targetSha, base);
        assert.equal(marker.sourceSha, source);
        if (args.length === 4) assert.equal(marker.releaseTag, `${tag}-fork.2`);
      }
      for (const args of [
        ["b".repeat(40), source, tag],
        [base, "main", tag],
        [base, source, tag, `${tag}-fork.nope`],
      ]) {
        const result = run(...args);
        assert.notEqual(result.status, 0);
        assert.equal(result.stdout, "");
      }
    } finally {
      repo.cleanup();
    }
  });
});
