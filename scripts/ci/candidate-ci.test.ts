// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
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
          assert.include(endpoint, `head_sha=${source}&branch=ci-candidate%2F${source}`);
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

  it("recovers a retained candidate with no push run through an exact manual dispatch", async () => {
    let dispatched = false;
    const query = (endpoint: string) =>
      endpoint.includes("/workflows/")
        ? { workflow_runs: dispatched ? [{ ...runFor(), event: "workflow_dispatch" }] : [] }
        : jobs();
    assert.isFalse((await reuseCandidateCI({ repository, source, query })).reused);
    dispatched = true;
    assert.isTrue((await reuseCandidateCI({ repository, source, query })).reused);
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
const workflowStep = (workflow: string, name: string): string => {
  const source = NodeFS.readFileSync(
    new URL(`../../.github/workflows/${workflow}`, import.meta.url),
    "utf8",
  );
  const step = source.split(`      - name: ${name}\n`)[1]!.split("\n      - ")[0]!;
  return step
    .split("        run: |\n")[1]!
    .split("\n")
    .map((line) => line.slice(10))
    .join("\n");
};
describe("candidate staging", () => {
  it("rejects missing workflow-triggering credentials before checkout or candidate staging", () => {
    const command = workflowStep("sync-upstream.yml", "Require workflow-triggering credentials");
    for (const token of ["", "fixture-pat"]) {
      const result = NodeChildProcess.spawnSync("bash", ["-e", "-c", command], {
        encoding: "utf8",
        env: { ...process.env, GH_TOKEN: token },
      });
      assert.equal(result.status, token ? 0 : 1);
    }
  });

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
      repo.writeFile(
        "docs/operations/fork-inventory.toml",
        `schema = 2
[[patch]]
name = "candidate"
subject = "test: candidate"
class = "product"
purpose = "Verify candidate metadata transport."
retire_when = "Fixture ends."
depends_on = []
roles = ["lockfile-owner", "release-workflow-owner", "agent-docs-owner"]
`,
      );
      const head = repo.commitAll("test: candidate");
      repo.writeFile(
        "stack.json",
        JSON.stringify({
          version: 5,
          prev: main,
          head,
          applied: ["candidate"],
          unapplied: [],
          hidden: [],
          patches: { candidate: { oid: head } },
        }),
      );
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

      // Execute CI's real metadata-fetch step in a clean checkout, then the
      // production checker, so a green fixture proves transport plus policy.
      const checkout = NodePath.join(remote.dir, "checkout");
      remote.git("clone", "--no-checkout", remotePath, checkout);
      remote.git("-C", checkout, "checkout", head);
      const env = {
        ...process.env,
        PATH: `/usr/bin:/bin:${process.env.PATH ?? ""}`,
        GITHUB_SHA: head,
        GITHUB_REF: `refs/heads/ci-candidate/${head}`,
      };
      NodeChildProcess.execFileSync(
        "bash",
        ["-e", "-o", "pipefail", "-c", workflowStep("ci.yml", "Fetch StGit metadata")],
        { cwd: checkout, env, stdio: "pipe" },
      );
      const checked = NodeChildProcess.execFileSync(
        NodeURL.fileURLToPath(new URL("./check-stgit-stack", import.meta.url)),
        [],
        { cwd: checkout, env, encoding: "utf8" },
      );
      assert.include(checked, "1 applied patches");

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

describe("publication CI requirement", () => {
  for (const state of ["green", "red", "missing", "main-only", "unchanged"] as const) {
    it(`requires exact candidate evidence for changed source (${state})`, () => {
      const repo = createFixtureRepo();
      try {
        repo.git("remote", "add", "origin", "https://github.com/owner/fork.git");
        repo.writeFile("source.ts", "repair\n");
        const head = repo.commitAll("fix: candidate");
        NodeFS.mkdirSync(NodePath.join(repo.dir, "scripts/ci"), { recursive: true });
        NodeFS.copyFileSync(
          NodePath.resolve(import.meta.dirname, "reuse-release-ci.ts"),
          NodePath.join(repo.dir, "scripts/ci/reuse-release-ci.ts"),
        );
        const bin = NodePath.join(repo.dir, ".git/bin");
        NodeFS.mkdirSync(bin);
        const evidence = {
          workflow_runs:
            state === "missing" || state === "main-only"
              ? []
              : [{ ...runFor(head), conclusion: state === "red" ? "failure" : "success" }],
        };
        NodeFS.writeFileSync(NodePath.join(bin, "runs.json"), JSON.stringify(evidence));
        NodeFS.writeFileSync(NodePath.join(bin, "jobs.json"), JSON.stringify(jobs()));
        NodeFS.writeFileSync(
          NodePath.join(bin, "main.json"),
          JSON.stringify({ workflow_runs: [{ ...runFor(head), head_branch: "main" }] }),
        );
        NodeFS.writeFileSync(
          NodePath.join(bin, "gh"),
          `#!/usr/bin/env bash
if [[ "$1" == repo ]]; then echo owner/fork
elif [[ "$2" == *'branch=main'* ]]; then cat '${bin}/main.json'
elif [[ "$2" == *'/jobs?'* ]]; then cat '${bin}/jobs.json'
else cat '${bin}/runs.json'
fi
`,
          { mode: 0o755 },
        );
        const result = NodeChildProcess.spawnSync(
          NodePath.resolve(import.meta.dirname, "require-publication-ci"),
          [head, state === "unchanged" ? head : "b".repeat(40)],
          {
            cwd: repo.dir,
            encoding: "utf8",
            env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
          },
        );
        assert.equal(
          result.status,
          state === "green" || state === "unchanged" ? 0 : 1,
          result.stdout + result.stderr,
        );
        if (state !== "green" && state !== "unchanged")
          assert.include(result.stderr, "Publication requires successful CI");
      } finally {
        repo.cleanup();
      }
    });
  }
});

describe("pinned nightly dispatch", () => {
  it("selects the requested public nightly and rejects incomplete or invalid pins", () => {
    const repo = createFixtureRepo();
    try {
      const bin = NodePath.join(repo.dir, ".git/bin");
      NodeFS.mkdirSync(bin);
      const tag = "v0.0.43-nightly.20260920.2005";
      NodeFS.writeFileSync(
        NodePath.join(bin, "gh"),
        `#!/usr/bin/env bash
printf '%s\\n' '{"tagName":"${tag}","isDraft":false,"isPrerelease":true}'
`,
        { mode: 0o755 },
      );
      const output = NodePath.join(repo.dir, ".git/output");
      const command = workflowStep("sync-upstream.yml", "Select upstream release tag").replaceAll(
        "${{ steps.channel.outputs.channel }}",
        "nightly",
      );
      for (const [target, sha, good] of [
        [tag, source, true],
        [tag, "", false],
        ["main", source, false],
        [tag, "not-a-sha", false],
        ["v0.0.43-nightly.20260919.1895", source, false],
      ] as const) {
        NodeFS.writeFileSync(output, "");
        const result = NodeChildProcess.spawnSync("bash", ["-euo", "pipefail", "-c", command], {
          cwd: repo.dir,
          encoding: "utf8",
          env: {
            ...process.env,
            PATH: `${bin}:${process.env.PATH}`,
            CHANNEL: "nightly",
            REQUESTED_TARGET: target,
            REQUESTED_TARGET_SHA: sha,
            GITHUB_OUTPUT: output,
          },
        });
        assert.equal(result.status === 0, good, result.stdout + result.stderr);
        assert.equal(NodeFS.readFileSync(output, "utf8"), good ? `tag=${tag}\n` : "");
      }
    } finally {
      repo.cleanup();
    }
  });

  it("rejects a stale nightly source before recording publication leases", () => {
    const repo = createFixtureRepo();
    try {
      const command = workflowStep("fork-push-nightly.yml", "Record main lease");
      const result = NodeChildProcess.spawnSync("bash", ["-euc", command], {
        cwd: repo.dir,
        encoding: "utf8",
        env: { ...process.env, EXPECTED_MAIN: "b".repeat(40) },
      });
      assert.equal(result.status, 1);
      assert.include(result.stdout, "Nightly dispatch source changed");
      assert.notInclude(
        result.stderr,
        "No such file",
        "must reject before calling the lease helper",
      );
    } finally {
      repo.cleanup();
    }
  });
});
