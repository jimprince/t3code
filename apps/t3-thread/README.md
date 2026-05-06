# t3-thread

Standalone operator CLI for T3 Code worker threads.

Primary command: `t3-thread`.
Compatibility alias: `t3-agent`.

Runtime state remains at `~/.config/t3-remote-agents/state.json` so existing paired environments and saved workers continue to work.

## Quick Start

```bash
t3-thread envs
t3-thread projects --env local-mbp

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

## Creation Model

`t3-thread create` is a thin wrapper over T3 Code's native `thread.turn.start` bootstrap flow.

- The CLI sends `bootstrap.createThread`.
- If `--branch` is present, the CLI sends `bootstrap.prepareWorktree`.
- T3 creates and records the worktree path.
- The CLI records saved names, notification routing, and local monitoring state.

Do not pass a worktree path and do not manually create a git worktree first.

## Common Commands

```bash
t3-thread threads --env local-mbp
t3-thread status worker-a
t3-thread worklog worker-a --tail 10
t3-thread result worker-a --wait 120 --final-message
t3-thread inbox
t3-thread send worker-a "Narrow the fix."
t3-thread archive worker-a
t3-thread forget worker-a
```

Legacy nested commands still work for compatibility:

```bash
t3-thread create ...
t3-thread status worker-a
```

Prefer the new direct form:

```bash
t3-thread create ...
t3-thread status worker-a
```

## Notifications

When `T3_THREAD_ID` is set, `create` auto-subscribes the caller thread to the new worker by default.

- Use `--no-notify` to opt out.
- Use `--notify <saved-agent-or-thread-id>` to route notifications to another subscriber.
- The watcher is normally run by launchd via `t3-thread watch --interval 5`.

## Docs

- Canonical skill: `/Users/brad/.shared/skills/t3-threads/SKILL.md`
- Overseer layer: `/Users/brad/.shared/skills/overseer-thread-management/SKILL.md`
- Runbook: `docs/AGENT_OPERATIONS.md`
- Remote T3 Code update runbook: `docs/REMOTE_T3CODE_UPDATE.md`
