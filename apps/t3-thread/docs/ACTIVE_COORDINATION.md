# Active Coordination

This standalone repo owns the `t3-thread` operator CLI.

## Current Canonical Command

```bash
t3-thread create \
  --name <saved-agent-name> \
  --env <environment> \
  --project <project-id> \
  --title "<thread title>" \
  --branch <branch> \
  --message "<brief>"

t3-thread status <saved-agent-name>
```

## Current Model

- `t3-thread` is primary.
- `t3-agent` is a compatibility alias.
- Runtime state remains in `~/.config/t3-remote-agents/state.json`.
- Creation uses T3 Code's native `thread.turn.start` bootstrap flow.
- T3 chooses and records worktree paths; callers do not pass `--worktree`.
- The watcher plist runs `t3-thread watch --interval 5`.

## Coordination Source

Project/task coordination for target repos may still live in the target repo tracker or in HomeNetwork's historical coordination board. This file records CLI-level state only.
