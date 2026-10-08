import type { Command } from "commander";
import { RemoteEnvironmentClient } from "./client.js";
import { loadState, requireEnvironment } from "./state.js";
import { installGiteaToken, type TokenOptions, type TokenDependencies } from "./giteaTokenCore.js";
export * from "./giteaTokenCore.js";

export function registerGiteaTokenCommand(
  program: Command,
  dependencies: Partial<TokenDependencies> = {},
) {
  program
    .command("source-control")
    .command("gitea")
    .command("set-token")
    .allowExcessArguments(false)
    .description("Set an existing instance token from bounded stdin and verify native Gitea reads")
    .requiredOption("--env <name>")
    .requiredOption("--instance <id>")
    .requiredOption("--token-stdin")
    .requiredOption("--root-thread <id>", "Root thread authorizing the native issue read")
    .requiredOption("--repository <owner/repo>")
    .requiredOption("--issue <number>", "Existing issue to read after updating")
    .action((options: TokenOptions) =>
      installGiteaToken(options, {
        ...dependencies,
        client:
          dependencies.client ??
          (async (name) =>
            new RemoteEnvironmentClient(requireEnvironment(await loadState(), name))),
      }),
    );
}
