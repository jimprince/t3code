# t3-thread

Standalone operator CLI for T3 Code worker threads.

Primary command: `t3-thread`.
Deprecated compatibility alias: `t3-agent` remains in place for old scripts and active threads. Do not use it in new instructions.

Runtime state remains at `~/.config/t3-remote-agents/state.json` so existing paired environments and saved workers continue to work.

The source now lives at `apps/t3-thread` in Brad's T3 Code fork. It remains a
separate workspace package and executable boundary; the move does not make it a
server-internal API or combine it with the unrelated `subagents` tool.

## Quick Start

```bash
t3-thread envs
t3-thread projects --env local-mbp
t3-thread models --env local-mbp
t3-thread project list --env local-mbp
t3-thread project add --env local-mbp --path /Users/brad/Programming/repo --title Repo

t3-thread create \
  --name worker-a \
  --env local-mbp \
  --project PROJECT_ID \
  --title "Worker A" \
  --branch t3/worker-a \
  --message "Inspect the repo and fix the issue."

t3-thread status worker-a
```

A real worker exists only after `create` returns a remote `threadId`.

Common lifecycle commands also accept a raw T3 `threadId` directly when you do
not want to create a saved alias first:

```bash
t3-thread status 22222222-2222-4222-8222-222222222222
t3-thread result 22222222-2222-4222-8222-222222222222 --final-message
t3-thread send 22222222-2222-4222-8222-222222222222 "Continue from the last checkpoint."
```

Resolution order for a raw UUID:

- prefer an existing saved mapping if that thread is already attached locally
- otherwise scan paired environments and infer environment/project metadata from the remote thread shell
- if not found, report the paired environments checked

## Creation Model

`t3-thread create` is a thin wrapper over T3 Code's native `thread.turn.start` bootstrap flow.

- The CLI sends `bootstrap.createThread`.
- If `--branch` is present, the CLI sends `bootstrap.prepareWorktree`.
- T3 creates and records the worktree path.
- The CLI records saved names, notification routing, and local monitoring state.

Do not pass a worktree path and do not manually create a git worktree first.

## Common Commands

```bash
t3-thread project list --env local-mbp
t3-thread models --env local-mbp
t3-thread project add --env local-mbp --path /Users/brad/Programming/repo --title Repo
t3-thread project rename --env local-mbp PROJECT_ID "New Title"
t3-thread project set-model --env local-mbp PROJECT_ID --provider codex --model gpt-5.4
t3-thread project set-model --env local-mbp PROJECT_ID --provider opencode
t3-thread project set-model --env local-mbp PROJECT_ID --provider cursor --model composer-2
t3-thread project set-model --env local-mbp PROJECT_ID --provider opencode --model google/antigravity-gemini-3.5-flash-high
t3-thread project remove --env local-mbp PROJECT_ID

t3-thread threads --env local-mbp
t3-thread status worker-a
t3-thread status 22222222-2222-4222-8222-222222222222
t3-thread worklog worker-a --tail 10
t3-thread worklog 22222222-2222-4222-8222-222222222222 --tail 10
t3-thread result worker-a --wait 120 --final-message
t3-thread result 22222222-2222-4222-8222-222222222222 --final-message
t3-thread inbox
t3-thread send worker-a "Narrow the fix."
t3-thread send 22222222-2222-4222-8222-222222222222 "Narrow the fix."
t3-thread archive worker-a
t3-thread archive 22222222-2222-4222-8222-222222222222
t3-thread forget worker-a
```

Supported direct-UUID lifecycle commands: `status`, `result`, `worklog`, `send`,
`clarify`, `revise`, `complete`, `wait`, `archive`, and `subscribe --watch`.

`attach` is still available when you want a persistent local alias. `result --mark-seen`
still requires a saved agent name because read state is stored locally.

Legacy nested commands still work for compatibility:

```bash
t3-thread agent create ...
t3-thread agent status worker-a
```

Use the direct canonical form in all new workflows:

```bash
t3-thread create ...
t3-thread status worker-a
```

## Project Management

`t3-thread project` manages projects on any paired environment, local or remote.
Paths must be absolute paths on the target environment.

```bash
t3-thread project list --env dev-vm
t3-thread models --env dev-vm
t3-thread project add --env dev-vm --path /home/brad/Programming/repo --title Repo --create-dir
t3-thread project rename --env dev-vm PROJECT_ID "Repo"
t3-thread project set-model --env dev-vm PROJECT_ID --provider codex --model gpt-5.4
t3-thread project set-model --env dev-vm PROJECT_ID --provider opencode
t3-thread project set-model --env dev-vm PROJECT_ID --provider cursor --model composer-2
t3-thread project set-model --env dev-vm PROJECT_ID --provider opencode --model google/antigravity-gemini-3.5-flash-high
t3-thread project set-model --env dev-vm PROJECT_ID --clear
t3-thread project remove --env dev-vm PROJECT_ID
```

`--provider` is the T3 Code provider instance id shown by the app, not a
closed CLI allowlist. Built-in ids such as `codex`, `claudeAgent`, `cursor`,
`grok`, and `opencode` work, and custom instance ids such as `codex_personal`
are passed through. `--model` accepts any model slug available for that
provider instance in the app; run `t3-thread models --env <environment>` to
see the live roster. If `--provider` is passed without `--model`, `t3-thread`
uses the current first non-custom model advertised by that provider, falling
back to the static compatibility default only when live config is unavailable.
OpenCode models must use OpenCode's provider/model slug format, for example
`google/antigravity-gemini-3.5-flash-high` or `openai/gpt-5`.

Safety defaults:

- `project add` only creates missing directories when `--create-dir` is passed.
- `project remove` refuses to remove a project with active threads unless `--force` is passed.
- If multiple active projects share a workspace root, use the project id instead of the path.

## Notifications

When `T3_THREAD_ID` is set, `create` auto-subscribes the caller thread to the new worker by default.
When `T3_ENVIRONMENT_ID` and `T3_ENVIRONMENT_NAME` are also set, the CLI resolves unsaved caller
threads directly from that environment metadata and maps it to the saved environment key used for routing.

- Use `--no-notify` to opt out.
- Use `--notify <saved-agent-or-thread-id>` to route notifications to another subscriber.

### Watcher lifecycle (on-demand)

`create` (with a notify subscription) and `subscribe` auto-spawn a detached background watcher if none is running — best-effort, never blocks the command. It is a singleton (pidfile `~/.config/t3-remote-agents/watch.pid`) and self-exits when idle:

- `--idle-exit <seconds>` (default 900): exit after this long with nothing in flight. It stays alive while any subscribed source thread is still running or any notification is undelivered, so completions are never missed. `0` disables.
- `--max-lifetime <seconds>` (default 21600): hard runtime backstop.
- `t3-thread watch --ensure`: spawn one if absent, else no-op (then exit).
- `t3-thread watch --once`: single throwaway scan (no pidfile/idle logic).

The launchd agent `~/Library/LaunchAgents/network.homenetwork.t3-watcher.plist` is **not** auto-loaded; load it manually only if you want a persistent 24/7 watcher.

## Docs

- Canonical skill: `/Users/brad/.shared/skills/t3-threads/SKILL.md`
- Overseer layer: `/Users/brad/.shared/skills/overseer-thread-management/SKILL.md`
- Runbook: `docs/AGENT_OPERATIONS.md`
- Remote ownership boundary: `docs/REMOTE_T3CODE_UPDATE.md`

This package owns worker-thread lifecycle only. Updating the remote `t3code.service`
is owned by the T3 Code fork's release docs, and VM/service/pairing/project
administration is owned by the shared `t3code-remote-ops` skill. See
`docs/REMOTE_T3CODE_UPDATE.md` for the routing.

## Monorepo Development

From the fork root, use Node `24.13.1` and the workspace toolchain:

```bash
pnpm --filter t3-thread test
pnpm --filter t3-thread typecheck
pnpm --filter t3-thread build
pnpm --filter t3-thread smoke
```

`dist/cli.cjs` remains committed and the dist-freshness test verifies it matches
the source build.
