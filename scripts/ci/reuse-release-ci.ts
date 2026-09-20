// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalConsole:off
// @effect-diagnostics globalTimers:off
// @effect-diagnostics globalDate:off
// Copied to RUNNER_TEMP before checkout; use native timers without workspace dependencies.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeUtil from "node:util";

const manifests = [
  "apps/server/package.json",
  "apps/desktop/package.json",
  "apps/web/package.json",
  "packages/contracts/package.json",
];
const requiredJobs = [
  "Check",
  "Test",
  "Test Server 1",
  "Test Server 2",
  "Test Server 3",
  "Release Smoke",
];
const candidateJobs = [...requiredJobs, "Rust", "Fork patch policy"];
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A stamped child may inherit source verification only when its sole change is package versions. */
export function releaseCISource(ref: string, version: string, cwd = process.cwd()): string {
  const git = (...args: string[]) =>
    NodeChildProcess.execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
  const target = git("rev-parse", "--verify", `${ref}^{commit}`);
  const parents = git("rev-list", "--parents", "-n", "1", target).split(" ");
  if (parents.length !== 2) return target;
  const parent = parents[1]!;
  const changed = git("diff", "--name-only", "--no-renames", parent, target).split("\n");
  if (!changed.every((path) => manifests.includes(path))) return target;
  // Mode changes, symlinks and other non-content changes are not version stamps.
  if (git("diff", "--summary", parent, target) !== "") return target;
  for (const path of manifests) {
    const before: unknown = JSON.parse(git("show", `${parent}:${path}`));
    const after: unknown = JSON.parse(git("show", `${target}:${path}`));
    if (!record(before) || !record(after) || after.version !== version) return target;
    const { version: _beforeVersion, ...beforeSource } = before;
    const { version: _afterVersion, ...afterSource } = after;
    if (!NodeUtil.isDeepStrictEqual(beforeSource, afterSource)) return target;
  }
  return parent;
}

const github = (endpoint: string): unknown =>
  JSON.parse(
    NodeChildProcess.execFileSync("gh", ["api", endpoint], {
      encoding: "utf8",
      timeout: 30_000,
      stdio: ["ignore", "pipe", "pipe"],
    }),
  );

/** The candidate uses this same workflow, source, toolchain and hosted Linux job profile. */
export async function reuseCandidateCI(options: {
  repository: string;
  source: string;
  maxWaitMs?: number;
  query?: (endpoint: string) => unknown;
  sleep?: (ms: number) => Promise<void>;
}): Promise<{ reused: boolean; reason: string; runUrl?: string }> {
  const fallback = (reason: string) => ({ reused: false, reason });
  try {
    if (!/^[0-9a-f]{40}$/.test(options.source)) return fallback("Invalid candidate commit.");
    const query = options.query ?? github;
    const sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    const deadline = Date.now() + (options.maxWaitMs ?? 0);
    const discoveryDeadline = Math.min(deadline, Date.now() + 120_000);
    const branch = `ci-candidate/${options.source}`;
    for (;;) {
      const response = query(
        `repos/${options.repository}/actions/workflows/ci.yml/runs?head_sha=${options.source}&branch=${encodeURIComponent(branch)}&per_page=1`,
      );
      if (!record(response) || !Array.isArray(response.workflow_runs))
        return fallback("Candidate CI run evidence unavailable.");
      const run = response.workflow_runs[0];
      if (run === undefined) {
        if (Date.now() >= discoveryDeadline)
          return fallback(
            "No candidate CI run. Candidate pushes require credentials that trigger Actions.",
          );
      } else {
        if (
          !record(run) ||
          run.head_sha !== options.source ||
          !["push", "workflow_dispatch"].includes(String(run.event)) ||
          run.head_branch !== branch ||
          run.path !== ".github/workflows/ci.yml" ||
          !record(run.repository) ||
          run.repository.full_name !== options.repository ||
          typeof run.id !== "number" ||
          !Number.isSafeInteger(run.id) ||
          run.id <= 0 ||
          typeof run.run_attempt !== "number" ||
          !Number.isSafeInteger(run.run_attempt) ||
          run.run_attempt <= 0
        )
          return fallback("Candidate CI provenance does not match.");
        if (run.status === "completed") {
          if (run.conclusion !== "success") return fallback("Candidate CI did not succeed.");
          const evidence = query(
            `repos/${options.repository}/actions/runs/${run.id}/attempts/${run.run_attempt}/jobs?per_page=100`,
          );
          if (
            !record(evidence) ||
            !Array.isArray(evidence.jobs) ||
            evidence.total_count !== evidence.jobs.length
          )
            return fallback("Candidate CI job evidence is incomplete.");
          for (const name of candidateJobs) {
            const matches = evidence.jobs.filter((job) => record(job) && job.name === name);
            const job = matches[0];
            if (
              matches.length !== 1 ||
              !record(job) ||
              job.status !== "completed" ||
              job.conclusion !== "success" ||
              !Array.isArray(job.labels) ||
              !job.labels.includes("ubuntu-24.04")
            )
              return fallback(`Candidate CI job did not pass on the expected runner: ${name}.`);
            const step =
              name === "Check"
                ? "Check source"
                : name === "Test" || name.startsWith("Test Server ")
                  ? "Test"
                  : undefined;
            const steps = job.steps;
            if (
              step &&
              (!Array.isArray(steps) ||
                ![step, "Check verified source unchanged"].every((required) =>
                  steps.some(
                    (item) =>
                      record(item) &&
                      item.name === required &&
                      item.status === "completed" &&
                      item.conclusion === "success",
                  ),
                ))
            )
              return fallback(`Candidate CI did not execute source verification: ${name}.`);
          }
          return {
            reused: true,
            reason: `Reusing candidate CI for exact source ${options.source}; workflow and toolchain are from that commit.`,
            runUrl: `https://github.com/${options.repository}/actions/runs/${run.id}/attempts/${run.run_attempt}`,
          };
        }
        if (!["queued", "in_progress", "waiting", "pending"].includes(String(run.status)))
          return fallback("Candidate CI has an unexpected status.");
      }
      if (Date.now() >= deadline) return fallback("Candidate CI is not ready.");
      await sleep(Math.min(15_000, Math.max(0, deadline - Date.now())));
    }
  } catch {
    return fallback("Could not establish candidate CI evidence.");
  }
}

/** Reuse a completed, successful main-push CI attempt, otherwise run release verification. */
export async function reuseReleaseCI(options: {
  repository: string;
  ref: string;
  version: string;
  cwd?: string;
  maxWaitMs?: number;
  query?: (endpoint: string) => unknown;
  sleep?: (ms: number) => Promise<void>;
}): Promise<{ reused: boolean; reason: string; runUrl?: string }> {
  try {
    const source = releaseCISource(options.ref, options.version, options.cwd);
    const query = options.query ?? github;
    const sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    const deadline = Date.now() + (options.maxWaitMs ?? 900_000);
    for (;;) {
      const response = query(
        `repos/${options.repository}/actions/workflows/ci.yml/runs?head_sha=${source}&event=push&branch=main&per_page=1`,
      );
      const run =
        record(response) && Array.isArray(response.workflow_runs)
          ? response.workflow_runs[0]
          : undefined;
      if (
        !record(run) ||
        run.head_sha !== source ||
        run.event !== "push" ||
        run.head_branch !== "main" ||
        run.path !== ".github/workflows/ci.yml" ||
        !record(run.repository) ||
        run.repository.full_name !== options.repository ||
        typeof run.id !== "number" ||
        !Number.isSafeInteger(run.id) ||
        run.id <= 0 ||
        typeof run.run_attempt !== "number" ||
        !Number.isSafeInteger(run.run_attempt) ||
        run.run_attempt <= 0
      ) {
        return {
          reused: false,
          reason: "No matching main-push CI evidence; running release verification.",
        };
      }
      if (run.status === "completed") {
        if (run.conclusion !== "success")
          return {
            reused: false,
            reason: "Matching CI did not succeed; running release verification.",
          };
        const jobs = query(
          `repos/${options.repository}/actions/runs/${run.id}/attempts/${run.run_attempt}/jobs?per_page=100`,
        );
        if (!record(jobs) || !Array.isArray(jobs.jobs))
          return {
            reused: false,
            reason: "CI job evidence unavailable; running release verification.",
          };
        const completed = new Set(
          jobs.jobs
            .filter(
              (job) => record(job) && job.status === "completed" && job.conclusion === "success",
            )
            .map((job) => job.name),
        );
        if (!requiredJobs.every((name) => completed.has(name))) {
          // A promoted candidate skips duplicate jobs on main. Dereference the
          // actual candidate run; a green evidence job alone is not proof.
          return reuseCandidateCI({ repository: options.repository, source, query });
        }
        return {
          reused: true,
          reason: `Reusing successful CI source verification for ${source}.`,
          runUrl: `https://github.com/${options.repository}/actions/runs/${run.id}`,
        };
      }
      if (
        !["queued", "in_progress", "waiting", "pending"].includes(String(run.status)) ||
        Date.now() >= deadline
      ) {
        return { reused: false, reason: "Matching CI is not ready; running release verification." };
      }
      await sleep(Math.min(15_000, Math.max(0, deadline - Date.now())));
    }
  } catch {
    return {
      reused: false,
      reason: "Could not establish matching CI evidence; running release verification.",
    };
  }
}

if (import.meta.main) {
  const candidate = process.argv.includes("--candidate");
  const wait = process.argv.includes("--wait");
  const repository = process.env.GITHUB_REPOSITORY ?? "";
  const result = candidate
    ? await reuseCandidateCI({
        repository,
        source: process.env.CI_CANDIDATE_SHA ?? "",
        maxWaitMs: wait ? 1_500_000 : 0,
      })
    : await reuseReleaseCI({
        repository,
        ref: process.env.RELEASE_REF ?? "HEAD",
        version: process.env.RELEASE_VERSION ?? "",
      });
  console.log(result.reason);
  if (result.runUrl) console.log(result.runUrl);
  if (process.env.GITHUB_OUTPUT)
    NodeFS.appendFileSync(process.env.GITHUB_OUTPUT, `reused=${result.reused}\n`);
  if (process.env.GITHUB_OUTPUT && result.runUrl)
    NodeFS.appendFileSync(
      process.env.GITHUB_OUTPUT,
      `run_id=${result.runUrl.match(/\/actions\/runs\/(\d+)/)?.[1] ?? ""}\n`,
    );
  if (process.env.GITHUB_STEP_SUMMARY)
    NodeFS.appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      `${result.reason}${result.runUrl ? ` [CI run](${result.runUrl})` : ""}\n`,
    );
  if (wait && !result.reused) process.exitCode = 1;
}
