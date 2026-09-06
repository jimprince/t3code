#!/usr/bin/env bun

// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalConsole:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { formatInventoryStanza, inventoryPath, type PatchIdentity } from "./lib/stgit-candidate.ts";
import {
  assertNewConcernPaths,
  integrateConcerns,
  validateIntegrationPlan,
  type IntegrationConcern,
} from "./lib/stgit-integration.ts";
import { parseFlagArguments, requiredFlag, runCommand } from "./lib/stgit-command.ts";

const usage =
  "usage: scripts/ci/integrate-stgit-concerns --plan <json> --output <dir> [--remote <url>] [--expected-main <sha>]";

type StackContext = { readonly patches: readonly PatchIdentity[] };

const main = (): void => {
  const flags = parseFlagArguments(process.argv.slice(2), new Set());
  const allowed = new Set(["--plan", "--output", "--remote", "--expected-main"]);
  for (const flag of flags.keys()) if (!allowed.has(flag)) throw new Error(`unknown flag: ${flag}`);
  const sourceCwd = process.cwd();
  const plan = validateIntegrationPlan(
    JSON.parse(NodeFS.readFileSync(NodePath.resolve(requiredFlag(flags, "--plan")), "utf8")),
  );
  const output = NodePath.resolve(requiredFlag(flags, "--output"));
  const expectedMain = flags.get("--expected-main");
  const git = process.env.SYNC_GIT_BIN ?? "/usr/bin/git";
  const stg = process.env.STGIT_BIN ?? "stg";
  const remoteInput =
    typeof flags.get("--remote") === "string"
      ? (flags.get("--remote") as string)
      : runCommand(git, ["remote", "get-url", "origin"], { cwd: sourceCwd, quiet: true });
  const remote = /^[A-Za-z0-9._-]+$/.test(remoteInput)
    ? runCommand(git, ["remote", "get-url", remoteInput], { cwd: sourceCwd, quiet: true })
    : remoteInput;
  const gitEnv = { ...process.env, SYNC_GIT_BIN: git, STGIT_BIN: stg };
  const stgEnv = {
    ...gitEnv,
    PATH: `/usr/bin:/usr/local/bin:/opt/homebrew/bin:${process.env.PATH ?? ""}`,
  };
  const repoRoot = NodePath.resolve(NodePath.dirname(new URL(import.meta.url).pathname), "../..");

  runCommand(
    NodePath.join(repoRoot, "scripts/ci/prepare-stgit-agent-worktree"),
    [
      "--output",
      output,
      "--remote",
      remote,
      ...(typeof expectedMain === "string" ? ["--expected-main", expectedMain] : []),
    ],
    { cwd: sourceCwd, env: gitEnv },
  );
  // One claim for the whole batch: leases are captured before any edit.
  runCommand("scripts/ci/prepare-stgit-publication", [], { cwd: output, env: gitEnv });

  const context = (): StackContext =>
    JSON.parse(
      runCommand("scripts/ci/check-stgit-stack", ["--format=json"], {
        cwd: output,
        quiet: true,
        env: gitEnv,
      }),
    ) as StackContext;
  const before = context();
  const stackRef = "refs/stacks/stgit/adopt";
  let mark = runCommand(git, ["rev-parse", stackRef], { cwd: output, quiet: true });

  const apply = (concern: IntegrationConcern): void => {
    mark = runCommand(git, ["rev-parse", stackRef], { cwd: output, quiet: true });
    const repo = NodePath.resolve(concern.repo ?? sourceCwd);
    runCommand(git, ["fetch", "--no-tags", repo, concern.candidate], { cwd: output });
    const parents = runCommand(git, ["rev-list", "--parents", "-n", "1", concern.candidate], {
      cwd: output,
      quiet: true,
    });
    if (parents.split(" ").length !== 2)
      throw new Error("candidate must be exactly one non-merge commit");
    const paths = runCommand(
      git,
      ["diff-tree", "--no-commit-id", "--name-only", "-r", concern.candidate],
      { cwd: output, quiet: true },
    )
      .split("\n")
      .filter(Boolean);
    const patches = context().patches;
    const top = patches.at(-1)?.name;
    if (top === undefined) throw new Error("stack is empty");
    if (concern.kind === "refresh") {
      if (!patches.some(({ name }) => name === concern.owner))
        throw new Error(`owner is not an existing patch: ${concern.owner}`);
      runCommand(stg, ["goto", concern.owner], { cwd: output, env: stgEnv });
      runCommand(git, ["cherry-pick", "--no-commit", concern.candidate], { cwd: output });
      runCommand(git, ["add", "--", ...paths], { cwd: output });
      runCommand(stg, ["refresh", "--index"], { cwd: output, env: stgEnv });
      runCommand(stg, ["goto", top], { cwd: output, env: stgEnv });
      return;
    }
    assertNewConcernPaths(paths);
    if (patches.some(({ name }) => name === concern.patch.name))
      throw new Error(`patch already exists: ${concern.patch.name}`);
    for (const dependency of concern.patch.dependsOn)
      if (!patches.some(({ name }) => name === dependency))
        throw new Error(`candidate dependency is not an existing patch: ${dependency}`);
    runCommand(stg, ["new", concern.patch.name, "--message", concern.patch.subject], {
      cwd: output,
      env: stgEnv,
    });
    runCommand(git, ["cherry-pick", "--no-commit", concern.candidate], { cwd: output });
    const inventory = NodePath.join(output, inventoryPath);
    const current = NodeFS.readFileSync(inventory, "utf8");
    NodeFS.appendFileSync(
      inventory,
      `${current.endsWith("\n") ? "" : "\n"}${formatInventoryStanza(concern.patch)}`,
    );
    runCommand(git, ["add", "--", ...paths, inventoryPath], { cwd: output });
    runCommand(stg, ["refresh", "--index"], { cwd: output, env: stgEnv });
  };

  const check = (): void => {
    if (runCommand(git, ["status", "--porcelain"], { cwd: output, quiet: true }).length !== 0)
      throw new Error("applying the concern left a dirty worktree");
    runCommand("scripts/ci/check-stgit-stack", [], { cwd: output, env: gitEnv });
    runCommand("bun", ["scripts/ci/check-fork-docs.ts"], { cwd: output });
  };

  const rollback = (): void => {
    runCommand(git, ["reset", "--hard", "HEAD"], { cwd: output, quiet: true });
    runCommand(stg, ["reset", "--hard", mark], { cwd: output, env: stgEnv, quiet: true });
    if (runCommand(git, ["status", "--porcelain"], { cwd: output, quiet: true }).length !== 0)
      throw new Error("rollback left a dirty worktree; discard this checkout");
  };

  const outcomes = integrateConcerns(plan.concerns, { apply, check, rollback });
  const applied = outcomes.filter(({ status }) => status === "applied");
  const after = context();
  const names = new Set(after.patches.map(({ name }) => name));
  if (before.patches.some(({ name }) => !names.has(name)))
    throw new Error("a pre-existing patch disappeared during integration");
  console.log(
    JSON.stringify(
      {
        checkout: output,
        applied: applied.map(({ concern }) => concern.candidate),
        skipped: outcomes.flatMap((outcome) =>
          outcome.status === "skipped"
            ? [{ candidate: outcome.concern.candidate, reason: outcome.reason }]
            : [],
        ),
        next: `cd ${output} && scripts/ci/verify-stgit-replay && scripts/ci/publish-stgit-stack --check`,
      },
      null,
      2,
    ),
  );
  if (applied.length === 0) throw new Error("no concern could be integrated");
};

try {
  main();
} catch (error) {
  console.error(`StGit concern integration failed: ${String(error)}`);
  console.error(usage);
  process.exitCode = 1;
}
