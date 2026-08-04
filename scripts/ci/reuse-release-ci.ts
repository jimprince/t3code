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
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A stamped child may inherit tests only when its sole change is package versions. */
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

/** Reuse a completed, successful main-push CI attempt, otherwise run release tests. */
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
    const deadline = Date.now() + (options.maxWaitMs ?? 300_000);
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
          reason: "No matching main-push CI evidence; running release tests.",
        };
      }
      if (run.status === "completed") {
        if (run.conclusion !== "success")
          return { reused: false, reason: "Matching CI did not succeed; running release tests." };
        const jobs = query(
          `repos/${options.repository}/actions/runs/${run.id}/attempts/${run.run_attempt}/jobs?per_page=100`,
        );
        if (!record(jobs) || !Array.isArray(jobs.jobs))
          return { reused: false, reason: "CI job evidence unavailable; running release tests." };
        const completed = new Set(
          jobs.jobs
            .filter(
              (job) => record(job) && job.status === "completed" && job.conclusion === "success",
            )
            .map((job) => job.name),
        );
        if (!requiredJobs.every((name) => completed.has(name)))
          return {
            reused: false,
            reason: "Required CI jobs did not all succeed; running release tests.",
          };
        return {
          reused: true,
          reason: `Reusing successful CI tests for ${source}.`,
          runUrl: `https://github.com/${options.repository}/actions/runs/${run.id}`,
        };
      }
      if (
        !["queued", "in_progress", "waiting", "pending"].includes(String(run.status)) ||
        Date.now() >= deadline
      ) {
        return { reused: false, reason: "Matching CI is not ready; running release tests." };
      }
      await sleep(Math.min(15_000, Math.max(0, deadline - Date.now())));
    }
  } catch {
    return {
      reused: false,
      reason: "Could not establish matching CI evidence; running release tests.",
    };
  }
}

if (import.meta.main) {
  const result = await reuseReleaseCI({
    repository: process.env.GITHUB_REPOSITORY ?? "",
    ref: process.env.RELEASE_REF ?? "HEAD",
    version: process.env.RELEASE_VERSION ?? "",
  });
  console.log(result.reason);
  if (result.runUrl) console.log(result.runUrl);
  NodeFS.appendFileSync(process.env.GITHUB_OUTPUT!, `reused=${result.reused}\n`);
  if (process.env.GITHUB_STEP_SUMMARY)
    NodeFS.appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      `${result.reason}${result.runUrl ? ` [CI run](${result.runUrl})` : ""}\n`,
    );
}
