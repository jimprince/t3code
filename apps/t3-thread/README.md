# t3-thread

Standalone operator CLI for T3 Code worker threads.

Primary command: `t3-thread`.
Deprecated compatibility alias: `t3-agent` remains in place for old scripts and active threads. Do not use it in new instructions.

Runtime state remains at `~/.config/t3-remote-agents/state.json` so existing paired environments and saved workers continue to work.

## Quick Start

```bash
t3-thread envs
t3-thread projects --env local-mbp
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
t3-thread project add --env local-mbp --path /Users/brad/Programming/repo --title Repo
t3-thread project rename --env local-mbp PROJECT_ID "New Title"
t3-thread project set-model --env local-mbp PROJECT_ID --provider codex --model gpt-5.4
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
t3-thread project add --env dev-vm --path /home/brad/Programming/repo --title Repo --create-dir
t3-thread project rename --env dev-vm PROJECT_ID "Repo"
t3-thread project set-model --env dev-vm PROJECT_ID --provider codex --model gpt-5.4
t3-thread project set-model --env dev-vm PROJECT_ID --provider opencode --model google/antigravity-gemini-3.5-flash-high
t3-thread project set-model --env dev-vm PROJECT_ID --clear
t3-thread project remove --env dev-vm PROJECT_ID
```

OpenCode models must use OpenCode's provider/model slug format, for example
`google/antigravity-gemini-3.5-flash-high` or
`google/antigravity-gemini-3.5-flash-low`.

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
- `create` and `subscribe` now best-effort spawn a singleton background watcher automatically when a notification route is attached.
- The watcher self-exits after 15 minutes idle by default and can be forced manually with `t3-thread watch --ensure`.

## Docs

- Canonical skill: `/Users/brad/.shared/skills/t3-threads/SKILL.md`
- Overseer layer: `/Users/brad/.shared/skills/overseer-thread-management/SKILL.md`
- Runbook: `docs/AGENT_OPERATIONS.md`
- Remote T3 Code update runbook: `docs/REMOTE_T3CODE_UPDATE.md`
