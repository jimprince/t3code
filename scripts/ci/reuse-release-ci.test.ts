// @effect-diagnostics nodeBuiltinImport:off
import { assert, describe, it } from "vite-plus/test";
import { createFixtureRepo, type FixtureRepo } from "./lib/git-fixture.ts";
import { releaseCISource, reuseReleaseCI } from "./reuse-release-ci.ts";

const version = "0.0.39-nightly.20260904.1280-fork.5";
const repository = "owner/fork";
const manifests = [
  "apps/server/package.json",
  "apps/desktop/package.json",
  "apps/web/package.json",
  "packages/contracts/package.json",
];
const jobs = ["Check", "Test", "Test Server 1", "Test Server 2", "Test Server 3", "Release Smoke"];
function seed(repo: FixtureRepo) {
  for (const path of manifests)
    repo.writeFile(path, JSON.stringify({ version: "0.0.0", dependencies: { example: "1.0.0" } }));
  repo.writeFile("pnpm-lock.yaml", "lockfileVersion: '9.0'\n");
  return repo.commitAll("source");
}
function stamp(repo: FixtureRepo) {
  for (const path of manifests)
    repo.writeFile(path, JSON.stringify({ version, dependencies: { example: "1.0.0" } }));
  return repo.commitAll("stamp");
}
const runFor = (sha: string) => ({
  id: 42,
  run_attempt: 2,
  head_sha: sha,
  head_branch: "main",
  event: "push",
  path: ".github/workflows/ci.yml",
  repository: { full_name: repository },
  status: "completed",
  conclusion: "success",
});
const jobEvidence = () => ({
  jobs: jobs.map((name) => ({ name, status: "completed", conclusion: "success" })),
});

describe("release CI reuse", () => {
  it("reuses the exact commit and a verified version-only child, binding the run attempt", async () => {
    const repo = createFixtureRepo();
    try {
      const source = seed(repo);
      const query = (endpoint: string) => {
        if (endpoint.includes("workflows/ci.yml")) {
          assert.include(endpoint, `head_sha=${source}&event=push&branch=main`);
          return { workflow_runs: [runFor(source)] };
        }
        assert.equal(endpoint, `repos/${repository}/actions/runs/42/attempts/2/jobs?per_page=100`);
        return jobEvidence();
      };
      const options = { repository, ref: source, version, cwd: repo.dir, query };
      assert.isTrue((await reuseReleaseCI(options)).reused);
      const child = stamp(repo);
      assert.equal(releaseCISource(child, version, repo.dir), source);
      const result = await reuseReleaseCI({ ...options, ref: child });
      assert.isTrue(result.reused);
      assert.equal(result.runUrl, `https://github.com/${repository}/actions/runs/42`);
    } finally {
      repo.cleanup();
    }
  });

  for (const mutation of [
    "dependency",
    "lockfile",
    "source",
    "workflow",
    "mode",
    "wrong-version",
  ]) {
    it(`does not inherit parent CI after a ${mutation} change`, async () => {
      const repo = createFixtureRepo();
      try {
        const source = seed(repo);
        stamp(repo);
        if (mutation === "dependency")
          repo.writeFile(
            manifests[0]!,
            JSON.stringify({ version, dependencies: { example: "2.0.0" } }),
          );
        if (mutation === "lockfile") repo.writeFile("pnpm-lock.yaml", "changed\n");
        if (mutation === "source") repo.writeFile("apps/server/source.ts", "changed\n");
        if (mutation === "workflow") repo.writeFile(".github/workflows/ci.yml", "changed\n");
        if (mutation === "mode") repo.git("update-index", "--chmod=+x", manifests[0]!);
        if (mutation === "wrong-version")
          repo.writeFile(
            manifests[0]!,
            JSON.stringify({ version: "wrong", dependencies: { example: "1.0.0" } }),
          );
        // Amend the prepared child, keeping the already-verified source as parent.
        if (mutation !== "mode") repo.git("add", "-A");
        repo.git("commit", "--amend", "--no-edit");
        const target = repo.git("rev-parse", "HEAD");
        assert.equal(releaseCISource(target, version, repo.dir), target);
        assert.isFalse(
          (
            await reuseReleaseCI({
              repository,
              ref: target,
              version,
              cwd: repo.dir,
              query: () => ({ workflow_runs: [runFor(source)] }),
            })
          ).reused,
        );
      } finally {
        repo.cleanup();
      }
    });
  }

  for (const invalid of [
    "failed",
    "cancelled",
    "pending",
    "missing",
    "wrong-sha",
    "wrong-event",
    "wrong-branch",
    "wrong-workflow",
    "wrong-repo",
    "missing-job",
    "skipped-job",
    "api-error",
  ]) {
    it(`runs release tests for ${invalid} CI evidence`, async () => {
      const repo = createFixtureRepo();
      try {
        const source = seed(repo);
        const run = runFor(source);
        const evidence = jobEvidence();
        if (invalid === "failed" || invalid === "cancelled") run.conclusion = invalid;
        if (invalid === "pending") run.status = "in_progress";
        if (invalid === "wrong-sha") run.head_sha = "0".repeat(40);
        if (invalid === "wrong-event") run.event = "pull_request";
        if (invalid === "wrong-branch") run.head_branch = "feature";
        if (invalid === "wrong-workflow") run.path = ".github/workflows/unrelated.yml";
        if (invalid === "wrong-repo") run.repository.full_name = "other/fork";
        if (invalid === "missing-job") evidence.jobs.pop();
        if (invalid === "skipped-job") evidence.jobs[1]!.conclusion = "skipped";
        const result = await reuseReleaseCI({
          repository,
          ref: source,
          version,
          cwd: repo.dir,
          maxWaitMs: 0,
          query: (endpoint) => {
            if (invalid === "api-error") throw new Error("API unavailable");
            return endpoint.includes("workflows/ci.yml")
              ? { workflow_runs: invalid === "missing" ? [] : [run] }
              : evidence;
          },
        });
        assert.isFalse(result.reused);
      } finally {
        repo.cleanup();
      }
    });
  }

  it("waits for the same-source CI to finish instead of duplicating its tests", async () => {
    const repo = createFixtureRepo();
    try {
      const source = seed(repo);
      let waiting = true;
      let waits = 0;
      const result = await reuseReleaseCI({
        repository,
        ref: source,
        version,
        cwd: repo.dir,
        query: (endpoint) =>
          endpoint.includes("workflows/ci.yml")
            ? {
                workflow_runs: [
                  { ...runFor(source), status: waiting ? "in_progress" : "completed" },
                ],
              }
            : jobEvidence(),
        sleep: async () => {
          waits++;
          waiting = false;
        },
      });
      assert.isTrue(result.reused);
      assert.equal(waits, 1);
    } finally {
      repo.cleanup();
    }
  });
});
