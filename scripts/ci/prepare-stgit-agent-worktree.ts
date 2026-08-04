#!/usr/bin/env bun

// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalConsole:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { parseFlagArguments, requiredFlag, runCommand } from "./lib/stgit-command.ts";

const usage =
  "usage: scripts/ci/prepare-stgit-agent-worktree --output <dir> --remote <url> [--expected-main <sha>] [--patch-name <name> --patch-subject <subject>]";

const main = (): void => {
  const flags = parseFlagArguments(process.argv.slice(2), new Set());
  const allowed = new Set([
    "--output",
    "--remote",
    "--expected-main",
    "--patch-name",
    "--patch-subject",
  ]);
  for (const flag of flags.keys()) if (!allowed.has(flag)) throw new Error(`unknown flag: ${flag}`);
  const output = NodePath.resolve(requiredFlag(flags, "--output"));
  const remote = requiredFlag(flags, "--remote");
  const expectedMain = flags.get("--expected-main");
  const patchName = flags.get("--patch-name");
  const patchSubject = flags.get("--patch-subject");
  if ((typeof patchName === "string") !== (typeof patchSubject === "string"))
    throw new Error("--patch-name and --patch-subject must be supplied together");
  if (NodeFS.existsSync(output)) throw new Error(`output already exists: ${output}`);

  const git = process.env.SYNC_GIT_BIN ?? "/usr/bin/git";
  const stg = process.env.STGIT_BIN ?? "stg";
  const parent = NodePath.dirname(output);
  NodeFS.mkdirSync(parent, { recursive: true });
  runCommand(git, ["clone", "--no-tags", remote, output], { cwd: parent });
  runCommand(git, ["fetch", "origin", "main"], { cwd: output });
  runCommand(git, ["switch", "--create", "stgit/adopt", "origin/main"], { cwd: output });
  runCommand(
    git,
    [
      "fetch",
      "origin",
      "+refs/stacks/stgit/adopt:refs/stacks/stgit/adopt",
      "+refs/patches/stgit/adopt/*:refs/patches/stgit/adopt/*",
    ],
    { cwd: output },
  );
  const mainSha = runCommand(git, ["rev-parse", "HEAD"], { cwd: output, quiet: true });
  if (typeof expectedMain === "string" && mainSha !== expectedMain)
    throw new Error(`remote main changed: expected ${expectedMain}, found ${mainSha}`);
  const series = runCommand(stg, ["series", "--all", "--description"], {
    cwd: output,
    quiet: true,
    env: {
      ...process.env,
      PATH: `/usr/bin:/usr/local/bin:/opt/homebrew/bin:${process.env.PATH ?? ""}`,
    },
  });
  if (series.length === 0)
    throw new Error(
      "StGit series is empty; metadata was not fetched or does not describe this checkout",
    );
  const contextText = runCommand("scripts/ci/check-stgit-stack", ["--format=json"], {
    cwd: output,
    quiet: true,
    env: { ...process.env, SYNC_GIT_BIN: git },
  });
  const context = JSON.parse(contextText) as {
    readonly patches?: readonly { readonly name?: unknown }[];
  };
  const stackSha = runCommand(git, ["rev-parse", "refs/stacks/stgit/adopt"], {
    cwd: output,
    quiet: true,
  });
  if (typeof patchName === "string" && typeof patchSubject === "string") {
    if (context.patches?.some(({ name }) => name === patchName))
      throw new Error(`patch already exists: ${patchName}`);
    const stgEnv = {
      ...process.env,
      PATH: `/usr/bin:/usr/local/bin:/opt/homebrew/bin:${process.env.PATH ?? ""}`,
    };
    runCommand(stg, ["new", patchName, "--message", patchSubject], {
      cwd: output,
      env: stgEnv,
    });
  }
  console.log(
    JSON.stringify(
      {
        contract: "t3code.stgit-agent-worktree",
        version: 1,
        path: output,
        main: mainSha,
        stack: stackSha,
        patchCount: context.patches?.length ?? 0,
        preparedPatch: typeof patchName === "string" ? patchName : null,
      },
      null,
      2,
    ),
  );
};

try {
  main();
} catch (error) {
  console.error(String(error));
  console.error(usage);
  process.exitCode = 1;
}
