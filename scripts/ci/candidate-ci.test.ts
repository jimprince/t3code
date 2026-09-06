// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { assert, describe, it } from "vite-plus/test";
import { createFixtureRepo } from "./lib/git-fixture.ts";
import { reuseCandidateCI, reuseReleaseCI } from "./reuse-release-ci.ts";

const source = "a".repeat(40);
const repository = "owner/fork";
const runFor = (sha = source) => ({
  id: 123,
  run_attempt: 2,
  head_sha: sha,
  head_branch: `ci-candidate/${sha}`,
  event: "push",
  path: ".github/workflows/ci.yml",
  repository: { full_name: repository },
  status: "completed",
  conclusion: "success",
});
const jobs = () => {
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
  return {
    total_count: names.length,
    jobs: names.map((name) => ({
      name,
      status: "completed",
      conclusion: "success",
      labels: ["ubuntu-24.04"],
      steps: [name === "Check" ? "Check source" : "Test", "Check verified source unchanged"].map(
        (name) => ({ name, status: "completed", conclusion: "success" }),
      ),
    })),
  };
};

describe("candidate CI evidence", () => {
  it("reuses the exact candidate attempt with complete executed source gates", async () => {
    const result = await reuseCandidateCI({
      repository,
      source,
      query: (endpoint) => {
        if (endpoint.includes("/workflows/")) {
          assert.include(endpoint, `head_sha=${source}&event=push&branch=ci-candidate%2F${source}`);
          return { workflow_runs: [runFor()] };
        }
        assert.equal(endpoint, `repos/${repository}/actions/runs/123/attempts/2/jobs?per_page=100`);
        return jobs();
      },
    });
    assert.isTrue(result.reused);
    assert.equal(result.runUrl, `https://github.com/${repository}/actions/runs/123/attempts/2`);
  });

  for (const invalid of [
    "sha",
    "branch",
    "event",
    "workflow",
    "repository",
    "attempt",
    "failed",
    "pending",
    "missing",
    "missing-job",
    "skipped-job",
    "skipped-source",
    "mutated-source",
    "platform",
    "truncated",
    "duplicate-job",
    "api-error",
  ]) {
    it(`rejects ${invalid} evidence`, async () => {
      const run = runFor();
      const evidence = jobs();
      if (invalid === "sha") run.head_sha = "b".repeat(40);
      if (invalid === "branch") run.head_branch = "main";
      if (invalid === "event") run.event = "pull_request";
      if (invalid === "workflow") run.path = ".github/workflows/unrelated.yml";
      if (invalid === "repository") run.repository.full_name = "other/fork";
      if (invalid === "attempt") run.run_attempt = 0;
      if (invalid === "failed") run.conclusion = "failure";
      if (invalid === "pending") run.status = "in_progress";
      if (invalid === "missing-job") {
        evidence.jobs.pop();
        evidence.total_count--;
      }
      if (invalid === "skipped-job") evidence.jobs[0]!.conclusion = "skipped";
      if (invalid === "skipped-source") evidence.jobs[0]!.steps[0]!.conclusion = "skipped";
      if (invalid === "mutated-source") evidence.jobs[0]!.steps[1]!.conclusion = "failure";
      if (invalid === "platform") evidence.jobs[0]!.labels = ["macos-15"];
      if (invalid === "truncated") evidence.total_count++;
      if (invalid === "duplicate-job") {
        evidence.jobs.push(evidence.jobs[0]!);
        evidence.total_count++;
      }
      const result = await reuseCandidateCI({
        repository,
        source,
        query: (endpoint) => {
          if (invalid === "api-error") throw new Error("offline");
          return endpoint.includes("/workflows/")
            ? { workflow_runs: invalid === "missing" ? [] : [run] }
            : evidence;
        },
      });
      assert.isFalse(result.reused);
    });
  }

  it("waits through event creation and the candidate run, without accepting pending evidence", async () => {
    let phase = 0;
    const result = await reuseCandidateCI({
      repository,
      source,
      maxWaitMs: 1000,
      query: (endpoint) =>
        endpoint.includes("/workflows/")
          ? {
              workflow_runs:
                phase === 0
                  ? []
                  : [{ ...runFor(), status: phase === 1 ? "in_progress" : "completed" }],
            }
          : jobs(),
      sleep: async () => {
        phase++;
      },
    });
    assert.isTrue(result.reused);
    assert.equal(phase, 2);
  });

  it("dereferences candidate evidence for a stamped release whose main jobs were reused", async () => {
    const repo = createFixtureRepo();
    try {
      const manifests = [
        "apps/server/package.json",
        "apps/desktop/package.json",
        "apps/web/package.json",
        "packages/contracts/package.json",
      ];
      for (const file of manifests) repo.writeFile(file, '{"version":"0.0.0"}');
      const head = repo.commitAll("source");
      for (const file of manifests) repo.writeFile(file, '{"version":"1.2.3"}');
      const tag = repo.commitAll("version stamp");
      let candidatePassed = true;
      const query = (endpoint: string) => {
        if (endpoint.includes("branch=main"))
          return { workflow_runs: [{ ...runFor(head), id: 456, head_branch: "main" }] };
        if (endpoint.includes("/456/"))
          return {
            jobs: [{ name: "Candidate CI evidence", status: "completed", conclusion: "success" }],
          };
        if (endpoint.includes("/workflows/"))
          return {
            workflow_runs: [
              { ...runFor(head), conclusion: candidatePassed ? "success" : "failure" },
            ],
          };
        return jobs();
      };
      assert.isTrue(
        (await reuseReleaseCI({ repository, ref: tag, version: "1.2.3", cwd: repo.dir, query }))
          .reused,
      );
      candidatePassed = false;
      assert.isFalse(
        (await reuseReleaseCI({ repository, ref: tag, version: "1.2.3", cwd: repo.dir, query }))
          .reused,
      );
    } finally {
      repo.cleanup();
    }
  });
});

const stage = NodeURL.fileURLToPath(new URL("./stage-ci-candidate", import.meta.url));
describe("candidate staging", () => {
  it("atomically stages immutable source/metadata inputs without publishing main or tags", () => {
    const repo = createFixtureRepo();
    const remote = createFixtureRepo();
    try {
      const main = repo.git("rev-parse", "HEAD");
      const remotePath = NodePath.join(remote.dir, "origin.git");
      remote.git("init", "--bare", remotePath);
      repo.git("remote", "add", "origin", remotePath);
      repo.git("push", "origin", `${main}:refs/heads/main`);
      repo.writeFile("source.ts", "new candidate\n");
      const head = repo.commitAll("candidate");
      repo.writeFile("stack.json", JSON.stringify({ head }));
      const metadata = repo.commitAll("metadata fixture");
      repo.git("update-ref", "refs/stacks/stgit/adopt", metadata);
      repo.git("reset", "--hard", head);
      const run = () =>
        NodeChildProcess.spawnSync("bash", [stage], {
          cwd: repo.dir,
          encoding: "utf8",
          env: {
            ...process.env,
            STGIT_REMOTE: "origin",
            PATH: `/usr/bin:/bin:${process.env.PATH ?? ""}`,
          },
        });
      const first = run();
      assert.equal(first.status, 0, first.stderr);
      assert.equal(repo.git("ls-remote", "origin", "refs/heads/main"), `${main}\trefs/heads/main`);
      assert.equal(repo.git("ls-remote", "origin", "refs/tags/*"), "");
      assert.equal(
        repo.git("ls-remote", "origin", `refs/heads/ci-candidate/${head}`),
        `${head}\trefs/heads/ci-candidate/${head}`,
      );
      assert.equal(
        repo.git("ls-remote", "origin", `refs/ci-stacks/${head}`),
        `${metadata}\trefs/ci-stacks/${head}`,
      );
      assert.equal(run().status, 0, "an identical retained candidate can be reused");
      repo.git("push", "--force", "origin", `${main}:refs/heads/ci-candidate/${head}`);
      assert.notEqual(run().status, 0, "staging must not replace a mismatched remote candidate");
      assert.equal(
        repo.git("ls-remote", "origin", `refs/heads/ci-candidate/${head}`),
        `${main}\trefs/heads/ci-candidate/${head}`,
      );
    } finally {
      repo.cleanup();
      remote.cleanup();
    }
  });
});
