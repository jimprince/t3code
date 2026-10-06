#!/usr/bin/env bun

// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalConsole:off
import * as NodeChildProcess from "node:child_process";
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
import {
  mergeInventoryStanzas,
  runUnionGate,
  unionAdditiveHunks,
  type UnionGateOperations,
} from "./lib/stgit-union.ts";

const usage =
  "usage: scripts/ci/integrate-stgit-concerns --plan <json> --output <dir> [--remote <url>] [--expected-main <sha>] [--no-union]";

type StackContext = { readonly patches: readonly PatchIdentity[] };

const main = (): void => {
  const flags = parseFlagArguments(process.argv.slice(2), new Set(["--no-union"]));
  const allowed = new Set(["--plan", "--output", "--remote", "--expected-main", "--no-union"]);
  for (const flag of flags.keys()) if (!allowed.has(flag)) throw new Error(`unknown flag: ${flag}`);
  const sourceCwd = process.cwd();
  const plan = validateIntegrationPlan(
    JSON.parse(NodeFS.readFileSync(NodePath.resolve(requiredFlag(flags, "--plan")), "utf8")),
  );
  const output = NodePath.resolve(requiredFlag(flags, "--output"));
  const expectedMain = flags.get("--expected-main");
  const git = process.env.SYNC_GIT_BIN ?? "/usr/bin/git";
  const stg = process.env.STGIT_BIN ?? "stg";
  const vp = process.env.VP_BIN ?? "vp";
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

  // Additive-conflict unions applied per candidate; a rolled-back concern's entries are dropped.
  const unions: { candidate: string; file: string; detail: string }[] = [];
  let unionsKept = 0;
  let installed = false;
  const gateOperations: UnionGateOperations = {
    format: (files) => {
      if (!installed && !NodeFS.existsSync(NodePath.join(output, "node_modules"))) {
        runCommand(vp, ["install", "--frozen-lockfile"], { cwd: output, env: stgEnv });
      }
      installed = true;
      runCommand(vp, ["fmt", "--check", "--no-error-on-unmatched-pattern", "--", ...files], {
        cwd: output,
        env: stgEnv,
      });
    },
    typecheckDirFor: (file) => {
      for (
        let directory = NodePath.dirname(file);
        directory !== ".";
        directory = NodePath.dirname(directory)
      ) {
        const manifest = NodePath.join(output, directory, "package.json");
        if (!NodeFS.existsSync(manifest)) continue;
        const scripts = (
          JSON.parse(NodeFS.readFileSync(manifest, "utf8")) as { scripts?: Record<string, string> }
        ).scripts;
        return scripts?.typecheck === undefined ? undefined : directory;
      }
      return undefined;
    },
    typecheck: (directory) => {
      runCommand(vp, ["run", "typecheck"], {
        cwd: NodePath.join(output, directory),
        env: stgEnv,
      });
    },
  };

  // Resolves a conflicted `cherry-pick --no-commit` when every conflict is a pure insertion on both
  // sides. Returns the files whose content was unioned (inventory excluded), or throws to skip.
  const resolveAdditiveConflicts = (
    concern: IntegrationConcern,
    order: readonly string[],
  ): string[] => {
    const unmerged = runCommand(git, ["ls-files", "-u"], { cwd: output, quiet: true })
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [meta, path] = line.split("\t");
        return { stage: Number(meta?.split(" ")[2]), path: path ?? "" };
      });
    const files = [...new Set(unmerged.map(({ path }) => path))];
    const unionedFiles: string[] = [];
    for (const file of files) {
      const stages = new Set(
        unmerged.filter(({ path }) => path === file).map(({ stage }) => stage),
      );
      if (![1, 2, 3].every((stage) => stages.has(stage)))
        throw new Error(`conflict in ${file} is not a content conflict; no union attempted`);
      if (file === inventoryPath) {
        const show = (stage: number): string =>
          NodeChildProcess.execFileSync(git, ["show", `:${stage}:${file}`], {
            cwd: output,
            encoding: "utf8",
          });
        const merged = mergeInventoryStanzas({
          base: show(1),
          ours: show(2),
          theirs: show(3),
          order,
        });
        if (!merged.ok) throw new Error(`inventory union refused: ${merged.reason}`);
        NodeFS.writeFileSync(NodePath.join(output, file), merged.text);
        unions.push({
          candidate: concern.candidate,
          file,
          detail: `stanza merge; added [${merged.added.join(", ")}] changed [${merged.changed.join(", ")}]`,
        });
        continue;
      }
      const result = unionAdditiveHunks(NodeFS.readFileSync(NodePath.join(output, file), "utf8"));
      if (!result.ok) throw new Error(`union refused for ${file}: ${result.reason}`);
      NodeFS.writeFileSync(NodePath.join(output, file), result.text);
      unionedFiles.push(file);
      unions.push({
        candidate: concern.candidate,
        file,
        detail: result.hunks
          .map((hunk) => `line ${hunk.line} (+${hunk.oursLines} ours, +${hunk.theirsLines} theirs)`)
          .join("; "),
      });
    }
    return unionedFiles;
  };

  // Cherry-picks without committing. A purely additive conflict is unioned unless --no-union.
  const cherryPick = (concern: IntegrationConcern, order: readonly string[]): string[] => {
    const picked = NodeChildProcess.spawnSync(
      git,
      ["-c", "merge.conflictStyle=diff3", "cherry-pick", "--no-commit", concern.candidate],
      { cwd: output, encoding: "utf8" },
    );
    if (picked.error) throw picked.error;
    if (picked.status === 0) return [];
    if (flags.has("--no-union")) throw new Error(`cherry-pick failed: ${picked.stderr.trim()}`);
    try {
      return resolveAdditiveConflicts(concern, order);
    } catch (error) {
      throw new Error(`${String(error)} (cherry-pick: ${picked.stderr.trim()})`);
    }
  };

  const gateUnions = (files: readonly string[]): void => {
    if (files.length > 0) runUnionGate(files, gateOperations);
  };

  const apply = (concern: IntegrationConcern): void => {
    unionsKept = unions.length;
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
      const unioned = cherryPick(
        concern,
        patches.map(({ name }) => name),
      );
      runCommand(git, ["add", "--", ...paths], { cwd: output });
      runCommand(stg, ["refresh", "--index"], { cwd: output, env: stgEnv });
      runCommand(stg, ["goto", top], { cwd: output, env: stgEnv });
      gateUnions(unioned);
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
    const unioned = cherryPick(
      concern,
      patches.map(({ name }) => name),
    );
    const inventory = NodePath.join(output, inventoryPath);
    const current = NodeFS.readFileSync(inventory, "utf8");
    NodeFS.appendFileSync(
      inventory,
      `${current.endsWith("\n") ? "" : "\n"}${formatInventoryStanza(concern.patch)}`,
    );
    runCommand(git, ["add", "--", ...paths, inventoryPath], { cwd: output });
    runCommand(stg, ["refresh", "--index"], { cwd: output, env: stgEnv });
    gateUnions(unioned);
  };

  const check = (): void => {
    if (runCommand(git, ["status", "--porcelain"], { cwd: output, quiet: true }).length !== 0)
      throw new Error("applying the concern left a dirty worktree");
    runCommand("scripts/ci/check-stgit-stack", [], { cwd: output, env: gitEnv });
    runCommand("bun", ["scripts/ci/check-fork-docs.ts"], { cwd: output });
  };

  const rollback = (): void => {
    unions.length = unionsKept;
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
  for (const union of unions)
    console.error(`union applied: ${union.candidate} ${union.file}: ${union.detail}`);
  console.log(
    JSON.stringify(
      {
        checkout: output,
        unions,
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
