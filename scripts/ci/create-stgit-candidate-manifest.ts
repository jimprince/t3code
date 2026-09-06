#!/usr/bin/env bun

// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalConsole:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { candidateContract, validateCandidateManifest } from "./lib/stgit-candidate.ts";
import { parseFlagArguments, requiredFlag, runCommand } from "./lib/stgit-command.ts";

const usage =
  "usage: scripts/ci/create-stgit-candidate-manifest --candidate <sha> --name <patch> --subject <subject> --class <class> --purpose <text> --retire-when <text> --verification-json <argv[][]> --output <json> [--depends-on-json <names[]>] [--remote <name>]";

const main = (): void => {
  const flags = parseFlagArguments(process.argv.slice(2), new Set());
  const allowed = new Set([
    "--candidate",
    "--name",
    "--subject",
    "--class",
    "--purpose",
    "--retire-when",
    "--verification-json",
    "--depends-on-json",
    "--output",
    "--remote",
  ]);
  for (const flag of flags.keys()) if (!allowed.has(flag)) throw new Error(`unknown flag: ${flag}`);
  const cwd = process.cwd();
  const git = process.env.SYNC_GIT_BIN ?? "/usr/bin/git";
  const remote =
    typeof flags.get("--remote") === "string" ? String(flags.get("--remote")) : "origin";
  const candidate = runCommand(git, ["rev-parse", requiredFlag(flags, "--candidate")], {
    cwd,
    quiet: true,
  });
  const candidateLine = runCommand(git, ["rev-list", "--parents", "-n", "1", candidate], {
    cwd,
    quiet: true,
  });
  if (candidateLine.split(" ").length !== 2)
    throw new Error("candidate must be exactly one non-merge commit");
  const remoteRefs = runCommand(
    git,
    ["ls-remote", "--refs", remote, "refs/heads/main", "refs/stacks/stgit/adopt"],
    { cwd, quiet: true },
  );
  const refs = Object.fromEntries(
    remoteRefs
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [oid, ref] = line.split("\t");
        if (!oid || !ref) throw new Error(`invalid remote ref record: ${line}`);
        return [ref, oid];
      }),
  );
  const baseMain = refs["refs/heads/main"];
  const baseStack = refs["refs/stacks/stgit/adopt"];
  if (!baseMain || !baseStack)
    throw new Error("remote is missing canonical main or stack metadata");
  const allowedPaths = runCommand(
    git,
    ["diff-tree", "--no-commit-id", "--name-only", "-r", candidate],
    { cwd, quiet: true },
  )
    .split("\n")
    .filter(Boolean);
  const manifest = validateCandidateManifest({
    contract: candidateContract,
    baseMain,
    baseStack,
    candidate,
    patch: {
      name: requiredFlag(flags, "--name"),
      subject: requiredFlag(flags, "--subject"),
      class: requiredFlag(flags, "--class"),
      purpose: requiredFlag(flags, "--purpose"),
      retireWhen: requiredFlag(flags, "--retire-when"),
      dependsOn: JSON.parse(
        typeof flags.get("--depends-on-json") === "string"
          ? String(flags.get("--depends-on-json"))
          : "[]",
      ) as unknown,
    },
    allowedPaths,
    verification: JSON.parse(requiredFlag(flags, "--verification-json")) as unknown,
  });
  const output = NodePath.resolve(requiredFlag(flags, "--output"));
  NodeFS.mkdirSync(NodePath.dirname(output), { recursive: true });
  NodeFS.writeFileSync(output, `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" });
  console.log(`Wrote ${output} for ${manifest.patch.name} at remote main ${manifest.baseMain}.`);
};

try {
  main();
} catch (error) {
  console.error(`Candidate manifest creation failed: ${String(error)}`);
  console.error(usage);
  process.exitCode = 1;
}
