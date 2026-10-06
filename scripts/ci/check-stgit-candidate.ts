#!/usr/bin/env bun

// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalConsole:off
import * as NodeFS from "node:fs";
import {
  assertCandidateScope,
  inventoryFile,
  validateCandidateManifest,
} from "./lib/stgit-candidate.ts";
import { parseFlagArguments, requiredFlag, runCommand } from "./lib/stgit-command.ts";

declare const Bun: { readonly TOML: { readonly parse: (contents: string) => unknown } };

const main = (): void => {
  const flags = parseFlagArguments(process.argv.slice(2), new Set());
  if ([...flags.keys()].some((flag) => flag !== "--manifest")) throw new Error("unknown flag");
  const manifest = validateCandidateManifest(
    JSON.parse(NodeFS.readFileSync(requiredFlag(flags, "--manifest"), "utf8")) as unknown,
  );
  const cwd = process.cwd();
  const git = process.env.SYNC_GIT_BIN ?? "/usr/bin/git";
  const stg = process.env.STGIT_BIN ?? "stg";
  const branch = runCommand(git, ["branch", "--show-current"], { cwd, quiet: true });
  if (branch !== "stgit/adopt") throw new Error(`expected branch stgit/adopt, found ${branch}`);
  const top = runCommand(stg, ["top"], { cwd, quiet: true });
  if (top !== manifest.patch.name)
    throw new Error(`expected top patch ${manifest.patch.name}, found ${top}`);
  const parent = runCommand(git, ["rev-parse", "HEAD^"], { cwd, quiet: true });
  if (parent !== manifest.baseMain)
    throw new Error(
      `candidate patch parent changed: expected ${manifest.baseMain}, found ${parent}`,
    );
  const subject = runCommand(git, ["show", "-s", "--format=%s", "HEAD"], { cwd, quiet: true });
  if (subject !== manifest.patch.subject)
    throw new Error(
      `candidate patch subject changed: expected ${manifest.patch.subject}, found ${subject}`,
    );

  const changed = new Set(
    runCommand(git, ["diff", "--name-only", "HEAD"], { cwd, quiet: true })
      .split("\n")
      .filter(Boolean),
  );
  for (const path of runCommand(git, ["ls-files", "--others", "--exclude-standard"], {
    cwd,
    quiet: true,
  })
    .split("\n")
    .filter(Boolean))
    changed.add(path);
  const inventory = inventoryFile(manifest.patch.name);
  assertCandidateScope(manifest.allowedPaths, [...changed], manifest.patch.name);
  for (const required of [...manifest.allowedPaths, inventory])
    if (!changed.has(required)) throw new Error(`manifest path was not changed: ${required}`);

  const entry = Bun.TOML.parse(NodeFS.readFileSync(inventory, "utf8")) as Record<string, unknown>;
  if (entry.name !== manifest.patch.name)
    throw new Error(`inventory name must match ${manifest.patch.name}`);
  const expected = manifest.patch;
  if (
    entry.subject !== expected.subject ||
    entry.class !== expected.class ||
    entry.purpose !== expected.purpose ||
    entry.retire_when !== expected.retireWhen ||
    JSON.stringify(entry.depends_on) !== JSON.stringify(expected.dependsOn) ||
    JSON.stringify(entry.roles) !== "[]"
  )
    throw new Error(`inventory entry for ${expected.name} does not match the candidate manifest`);
  console.log(
    `StGit candidate check PASS: ${expected.name} owns ${manifest.allowedPaths.length} paths.`,
  );
};

try {
  main();
} catch (error) {
  console.error(`StGit candidate check FAIL: ${String(error)}`);
  process.exitCode = 1;
}
