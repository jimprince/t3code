#!/usr/bin/env bun

// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalConsole:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import {
  assertPatchPrefixUnchanged,
  formatInventoryStanza,
  inventoryPath,
  validateCandidateManifest,
  type PatchIdentity,
} from "./lib/stgit-candidate.ts";
import { parseFlagArguments, requiredFlag, runCommand } from "./lib/stgit-command.ts";

type StackContext = {
  readonly contract: string;
  readonly version: number;
  readonly head: string;
  readonly patches: readonly PatchIdentity[];
};

const usage =
  "usage: scripts/ci/deploy-stgit-concern --manifest <json> [--remote <url>] [--candidate-repo <dir>] [--output <dir>] [--check|--push]";

const main = (): void => {
  const flags = parseFlagArguments(process.argv.slice(2), new Set(["--check", "--push"]));
  const allowed = new Set([
    "--manifest",
    "--remote",
    "--candidate-repo",
    "--output",
    "--check",
    "--push",
  ]);
  for (const flag of flags.keys()) if (!allowed.has(flag)) throw new Error(`unknown flag: ${flag}`);
  if (flags.has("--check") && flags.has("--push")) throw new Error("choose --check or --push");
  const mode = flags.has("--push") ? "--push" : "--check";
  const sourceCwd = process.cwd();
  const manifestPath = NodePath.resolve(requiredFlag(flags, "--manifest"));
  const manifest = validateCandidateManifest(
    JSON.parse(NodeFS.readFileSync(manifestPath, "utf8")) as unknown,
  );
  const git = process.env.SYNC_GIT_BIN ?? "/usr/bin/git";
  const stg = process.env.STGIT_BIN ?? "stg";
  const candidateRepo = NodePath.resolve(
    typeof flags.get("--candidate-repo") === "string"
      ? (flags.get("--candidate-repo") as string)
      : sourceCwd,
  );
  const remoteInput =
    typeof flags.get("--remote") === "string"
      ? (flags.get("--remote") as string)
      : runCommand(git, ["remote", "get-url", "origin"], { cwd: sourceCwd, quiet: true });
  const remote = /^[A-Za-z0-9._-]+$/.test(remoteInput)
    ? runCommand(git, ["remote", "get-url", remoteInput], { cwd: sourceCwd, quiet: true })
    : remoteInput;
  const output = NodePath.resolve(
    typeof flags.get("--output") === "string"
      ? (flags.get("--output") as string)
      : NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-stgit-candidate-")),
  );
  if (NodeFS.existsSync(output) && NodeFS.readdirSync(output).length === 0)
    NodeFS.rmdirSync(output);

  const repoRoot = NodePath.resolve(NodePath.dirname(new URL(import.meta.url).pathname), "../..");
  runCommand(
    NodePath.join(repoRoot, "scripts/ci/prepare-stgit-agent-worktree"),
    ["--output", output, "--remote", remote, "--expected-main", manifest.baseMain],
    { cwd: sourceCwd, env: { ...process.env, SYNC_GIT_BIN: git, STGIT_BIN: stg } },
  );
  const actualStack = runCommand(git, ["rev-parse", "refs/stacks/stgit/adopt"], {
    cwd: output,
    quiet: true,
  });
  if (actualStack !== manifest.baseStack)
    throw new Error(`remote stack changed: expected ${manifest.baseStack}, found ${actualStack}`);

  const contextText = runCommand("scripts/ci/check-stgit-stack", ["--format=json"], {
    cwd: output,
    quiet: true,
    env: { ...process.env, SYNC_GIT_BIN: git },
  });
  const before = JSON.parse(contextText) as StackContext;
  if (before.contract !== "t3code.stgit-stack-context" || before.version !== 1)
    throw new Error("prepared checkout returned an unsupported stack-context contract");
  if (before.patches.some(({ name }) => name === manifest.patch.name))
    throw new Error(`patch already exists: ${manifest.patch.name}`);
  for (const dependency of manifest.patch.dependsOn)
    if (!before.patches.some(({ name }) => name === dependency))
      throw new Error(`candidate dependency is not an existing patch: ${dependency}`);
  const remotePatchRefs = Object.fromEntries(
    runCommand(git, ["ls-remote", "--refs", "origin", "refs/patches/stgit/adopt/*"], {
      cwd: output,
      quiet: true,
    })
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [oid, ref] = line.split("\t");
        if (!oid || !ref) throw new Error(`invalid remote patch-ref record: ${line}`);
        return [ref, oid];
      }),
  );

  runCommand(git, ["fetch", "--no-tags", candidateRepo, manifest.candidate], {
    cwd: output,
  });
  const candidateLine = runCommand(git, ["rev-list", "--parents", "-n", "1", manifest.candidate], {
    cwd: output,
    quiet: true,
  });
  if (candidateLine.split(" ").length !== 2)
    throw new Error("candidate must be exactly one non-merge commit");
  const candidatePaths = runCommand(
    git,
    ["diff-tree", "--no-commit-id", "--name-only", "-r", manifest.candidate],
    { cwd: output, quiet: true },
  )
    .split("\n")
    .filter(Boolean)
    .sort();
  if (JSON.stringify(candidatePaths) !== JSON.stringify(manifest.allowedPaths))
    throw new Error(
      `candidate paths do not exactly match allowedPaths: ${JSON.stringify(candidatePaths)}`,
    );

  const stgEnv = {
    ...process.env,
    PATH: `/usr/bin:/usr/local/bin:/opt/homebrew/bin:${process.env.PATH ?? ""}`,
  };
  runCommand(stg, ["new", manifest.patch.name, "--message", manifest.patch.subject], {
    cwd: output,
    env: stgEnv,
  });
  runCommand(git, ["cherry-pick", "--no-commit", manifest.candidate], { cwd: output });
  const currentInventory = NodeFS.readFileSync(NodePath.join(output, inventoryPath), "utf8");
  NodeFS.appendFileSync(
    NodePath.join(output, inventoryPath),
    `${currentInventory.endsWith("\n") ? "" : "\n"}${formatInventoryStanza(manifest.patch)}`,
  );
  runCommand("scripts/ci/check-stgit-candidate", ["--manifest", manifestPath], {
    cwd: output,
    env: { ...process.env, SYNC_GIT_BIN: git, STGIT_BIN: stg },
  });
  runCommand(git, ["add", "--", ...manifest.allowedPaths, inventoryPath], { cwd: output });
  runCommand(stg, ["refresh", "--index"], { cwd: output, env: stgEnv });
  if (runCommand(git, ["status", "--porcelain"], { cwd: output, quiet: true }).length !== 0)
    throw new Error("candidate refresh left a dirty worktree");

  const after = JSON.parse(
    runCommand("scripts/ci/check-stgit-stack", ["--format=json"], {
      cwd: output,
      quiet: true,
      env: { ...process.env, SYNC_GIT_BIN: git },
    }),
  ) as StackContext;
  assertPatchPrefixUnchanged(before.patches, after.patches);
  const added = after.patches.at(-1);
  if (added?.name !== manifest.patch.name || added.subject !== manifest.patch.subject)
    throw new Error("refreshed patch identity does not match the candidate manifest");
  for (const command of manifest.verification)
    runCommand(command[0]!, command.slice(1), { cwd: output });
  runCommand("scripts/ci/check-stgit-stack", [], { cwd: output });
  runCommand("bun", ["scripts/ci/check-fork-docs.ts"], { cwd: output });
  runCommand("scripts/ci/publish-stgit-stack", [mode], {
    cwd: output,
    env: {
      ...process.env,
      SYNC_GIT_BIN: git,
      STGIT_REMOTE: "origin",
      STGIT_EXPECTED_REMOTE_MAIN: manifest.baseMain,
      STGIT_EXPECTED_REMOTE_STACK: manifest.baseStack,
      STGIT_EXPECTED_PATCH_REFS_JSON: JSON.stringify(remotePatchRefs),
      STGIT_BACKUP_NAMESPACE: "manual",
    },
  });
  console.log(
    `${mode === "--push" ? "Published" : "Validated"} ${manifest.patch.name} from isolated checkout ${output}`,
  );
};

try {
  main();
} catch (error) {
  console.error(`StGit concern deployment failed safely: ${String(error)}`);
  console.error(usage);
  process.exitCode = 1;
}
