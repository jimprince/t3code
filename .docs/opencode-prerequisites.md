# OpenCode prerequisites

This branch expects a working local OpenCode CLI installation before the OpenCode provider will become usable in T3 Code.

## Install OpenCode

Choose one supported install path:

```bash
# npm
npm i -g opencode-ai@latest

# Homebrew
brew install anomalyco/tap/opencode

# official install script
curl -fsSL https://opencode.ai/install | bash
```

After install, confirm the binary is available:

```bash
opencode --version
```

If you installed OpenCode outside your shell `PATH`, copy the full binary path. T3 Code can use that explicit path from Settings.

## Authenticate OpenCode

OpenCode provider credentials are managed by OpenCode itself, not by T3 Code.

Log in before using the provider:

```bash
opencode auth login
```

OpenCode can also read provider credentials from its own auth/config setup and related environment variables. T3 only checks that the CLI can run; provider-specific auth still has to be configured in OpenCode.

## Configure T3 Code

1. Open T3 Code Settings.
2. Find the OpenCode provider section.
3. Leave the binary path empty if `opencode` is already on `PATH`, or enter the full binary path if it is not.
4. Optionally add custom OpenCode model slugs such as `anthropic/claude-sonnet-4.5`.
5. Refresh providers from Settings so T3 re-runs the OpenCode health check and provider catalog discovery.

## What T3 validates

When T3 refreshes providers, it currently checks that:

- the OpenCode CLI can be executed,
- the CLI responds to `--version`,
- the OpenCode provider catalog can be loaded through the pooled sidecar path.

If the CLI is missing, T3 will report:

- `OpenCode CLI (\`opencode\`) is not installed or not on PATH.`

If you configured a custom binary path, the error message will name that path instead.

## What T3 manages for you

You do not need to start an OpenCode server manually. T3 starts and pools `opencode serve` sidecars automatically per workspace root and binary path.

The main things you still manage yourself are:

- OpenCode installation
- OpenCode authentication
- any custom OpenCode config outside T3, such as alternate config locations or provider credentials

## Suggested smoke test

After setup:

1. refresh providers in T3 Settings,
2. confirm OpenCode shows as available,
3. create a thread with the OpenCode provider,
4. send a basic prompt,
5. verify the thread can handle approvals or user-input prompts if the provider asks for them.
