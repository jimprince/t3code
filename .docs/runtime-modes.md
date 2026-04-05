# Runtime modes

T3 Code has a shared runtime-mode toggle in the chat toolbar:

- Full access
- Supervised

The UI is provider-neutral, but the backend implementation differs by provider.

## Codex

- Full access starts Codex with `approvalPolicy: never` and `sandboxMode: danger-full-access`.
- Supervised starts Codex with `approvalPolicy: on-request` and `sandboxMode: workspace-write`.
- Codex can apply runtime-mode changes directly to the active session model.

## OpenCode

- Full access maps to an allow-by-default OpenCode permission ruleset.
- Supervised maps to ask-on-use rules for the actions T3 currently treats as approval-sensitive:
  - file reads and discovery tools
  - file changes
  - bash execution
  - external-directory access

OpenCode runtime modes are implemented through permission rules, not Codex-style sandbox flags.

## Important OpenCode caveat

If you change runtime mode while an OpenCode session is already running, T3 does not mutate the live OpenCode session in place. Instead:

1. the thread stores the newly selected runtime mode as the desired next-session mode,
2. the active OpenCode session continues to report its current live runtime mode,
3. the new mode takes effect the next time T3 starts a fresh OpenCode session for that thread.

This is expected behavior on the current branch.
