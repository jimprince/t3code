# Provider architecture

The web app communicates with the server through a JSON-RPC-style WebSocket protocol:

- Request/Response: `{ id, body }` -> `{ id, result }` or `{ id, error }`
- Push events: typed envelopes with `channel`, `sequence`, and channel-specific `data`

Push channels include `server.welcome`, `server.configUpdated`, `server.providersUpdated`, `terminal.event`, and `orchestration.domainEvent`. Payloads are schema-validated at the transport boundary in `wsTransport.ts`.

## Server methods and config surface

Methods mirror the browser `NativeApi` contracts:

- orchestration methods such as `orchestration.dispatchCommand`, `orchestration.getSnapshot`, and diff queries
- terminal methods such as `terminal.open` and `terminal.write`
- server methods such as `server.getConfig`, `server.getSettings`, `server.updateSettings`, and `server.refreshProviders`

`server.getConfig` returns the startup snapshot the web app uses for provider status, settings, keybindings, and editor availability. `server.refreshProviders` forces the provider registry to re-run health checks and model discovery after a settings change.

## Implemented providers

- `codex`: backed by `codex app-server` over JSON-RPC stdio
- `claudeAgent`: backed by the existing Claude provider adapter
- `opencode`: backed by a pooled `opencode serve` sidecar plus the OpenCode SDK

OpenCode is a first-class provider in current contracts, server snapshots, settings, model selection, and the web composer picker. It is no longer a placeholder-only UI path.

## Provider layering

Provider state flows through a shared registry and service stack:

1. `ProviderRegistry` aggregates provider snapshots for Codex, Claude, and OpenCode.
2. `ProviderService` routes thread-scoped actions to the correct adapter.
3. Each adapter translates provider-native APIs and events into the canonical orchestration model.

For OpenCode specifically:

- `OpenCodeProvider` performs health checks, version probing, and provider catalog discovery.
- `OpenCodeServerPool` manages one reusable OpenCode sidecar per stable workspace-root and binary-path combination.
- `OpenCodeAdapter` owns session creation, session recovery, runtime-mode mapping, approvals, pending user-input questions, and event translation.

## OpenCode session and sidecar model

T3 does not require users to run `opencode serve` manually. When an OpenCode thread starts, the server:

1. resolves the configured OpenCode binary path,
2. acquires or starts a pooled `opencode serve` sidecar for the workspace root and binary path,
3. creates or recovers an OpenCode session through the SDK,
4. maps that session into the canonical `ProviderSession` snapshot stored in T3.

Pooling is keyed by workspace root plus binary path so multiple threads in the same project can reuse one sidecar while still keeping each thread's effective cwd/worktree isolated at the session layer.

## Runtime-mode behavior

Codex and OpenCode share the same toolbar runtime-mode control, but the backend implementation differs:

- Codex uses native sandbox and approval settings.
- OpenCode maps runtime modes to permission rulesets.

OpenCode permission mapping is intentionally coarse and focused on the major actions T3 surfaces:

- file reads and discovery tools
- file-changing tools
- bash execution
- external-directory access

If the user changes runtime mode while an OpenCode session is already active, T3 keeps the live session in its current permission state and applies the new mode the next time it starts a fresh OpenCode session. The thread stores the desired next-session runtime mode while the active session still reflects the true live permission state.

## Pending approvals and user input

OpenCode permission prompts and question prompts are normalized into canonical orchestration activities so the web app can render them alongside the existing provider flows.

The current web flow supports:

- approval prompts
- pending user-input questions with preset options
- custom-only questions
- multi-select questions
- option-only questions that disable freeform composer entry

Pending custom answers are treated as literal text and do not participate in the normal composer slash/path/model trigger system.
