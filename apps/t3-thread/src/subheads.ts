import type { Command } from "commander";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { RemoteEnvironmentClient } from "./client.js";
import { loadState, requireEnvironment } from "./state.js";

type Call = (
  environment: string,
  operation: string,
  input: Record<string, unknown>,
) => Promise<unknown>;
type Options = {
  env: string;
  file?: string;
  expectedVersion?: string;
  all?: boolean;
  requestId?: string;
  messageFile?: string;
};

/** One transport entry point; server admission and policy are shared with MCP. */
export function registerSubheadCommands(
  program: Command,
  dependencies?: { call: Call; print: (value: unknown) => void },
) {
  const call: Call =
    dependencies?.call ??
    (async (env, operation, input) => {
      const client = new RemoteEnvironmentClient(requireEnvironment(await loadState(), env));
      return client.automationRpc("subheads", { operation, ...input });
    });
  const print =
    dependencies?.print ??
    ((value: unknown) => process.stdout.write(`${JSON.stringify(value, null, 2)}\n`));
  const invoke = async (options: Options, operation: string, input: Record<string, unknown>) =>
    print(await call(options.env, operation, input));
  const group = program
    .command("subhead")
    .description("Manage versioned virtual helpers and retrieve their durable results");
  group
    .command("list")
    .requiredOption("--env <name>")
    .option("--all")
    .action((options: Options) => invoke(options, "list", { all: options.all === true }));
  group
    .command("show")
    .argument("<name>")
    .requiredOption("--env <name>")
    .action((name: string, options: Options) => invoke(options, "show", { name }));
  group
    .command("create")
    .requiredOption("--env <name>")
    .requiredOption("--file <path>")
    .action((options: Options) =>
      invoke(options, "create", { template: JSON.parse(readFileSync(options.file!, "utf8")) }),
    );
  group
    .command("edit")
    .argument("<name>")
    .requiredOption("--env <name>")
    .requiredOption("--file <path>")
    .requiredOption("--expected-version <number>")
    .action((name: string, options: Options) => {
      const expectedVersion = Number(options.expectedVersion);
      if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1)
        throw new Error("--expected-version must be a positive integer.");
      return invoke(options, "edit", {
        name,
        expectedVersion,
        template: JSON.parse(readFileSync(options.file!, "utf8")),
      });
    });
  for (const state of ["enable", "disable", "retire"] as const)
    group
      .command(state)
      .argument("<name>")
      .requiredOption("--env <name>")
      .action((name: string, options: Options) => invoke(options, "state", { name, state }));
  group
    .command("send")
    .argument("<name>")
    .argument("[request]")
    .requiredOption("--env <name>")
    .option("--request-id <id>")
    .option("--message-file <path>")
    .action((name: string, request: string | undefined, options: Options) => {
      if ((request === undefined) === (options.messageFile === undefined))
        throw new Error("Give a request or --message-file.");
      const requestId = options.requestId ?? randomUUID();
      return invoke(options, "send", {
        name,
        request: options.messageFile ? readFileSync(options.messageFile, "utf8") : request!,
        requestId,
      });
    });
  for (const operation of ["status", "result"] as const)
    group
      .command(operation)
      .argument("<run-id>")
      .requiredOption("--env <name>")
      .action((runId: string, options: Options) => invoke(options, operation, { runId }));
}
