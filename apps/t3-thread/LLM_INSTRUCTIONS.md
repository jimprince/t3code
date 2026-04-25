# LLM Instructions

This repo owns the standalone `t3-thread` operator CLI for creating, supervising, and retiring T3 Code worker threads.

## Read Order

1. [docs/AGENT_REQUIREMENTS.md](/Users/brad/Programming/t3-thread/docs/AGENT_REQUIREMENTS.md)
2. [README.md](/Users/brad/Programming/t3-thread/README.md)
3. [~/.shared/skills/t3-threads/SKILL.md](/Users/brad/.shared/skills/t3-threads/SKILL.md)
4. [~/.shared/skills/overseer-thread-management/SKILL.md](/Users/brad/.shared/skills/overseer-thread-management/SKILL.md) when coordinating multiple workers

## Purpose

- `t3-thread` is the primary command.
- `t3-agent` is a compatibility alias only.
- The CLI stores runtime state in `~/.config/t3-remote-agents/state.json` for compatibility with existing saved environments and agents.
- The CLI must remain a thin wrapper over T3 Code's native thread/bootstrap APIs. Do not recreate worktree or thread lifecycle manually.

## Canonical Creation Flow

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

Do not pass `--worktree`. T3 Code creates and records the worktree path through native bootstrap.

## Maintenance

When command names, lifecycle behavior, or notification routing change, update:

- [README.md](/Users/brad/Programming/t3-thread/README.md)
- [~/.shared/skills/t3-threads/SKILL.md](/Users/brad/.shared/skills/t3-threads/SKILL.md)
- [~/.shared/skills/overseer-thread-management/SKILL.md](/Users/brad/.shared/skills/overseer-thread-management/SKILL.md)
- `/Users/brad/.shared/bin/t3-thread`
- `/Users/brad/.shared/bin/t3-agent` compatibility alias
- `~/Library/LaunchAgents/network.homenetwork.t3-watcher.plist` if watcher invocation changes
