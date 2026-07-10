# LLM Instructions

This workspace package owns the standalone `t3-thread` operator CLI for creating,
supervising, and retiring T3 Code worker threads. It lives at
`apps/t3-thread` inside Brad's T3 Code fork but keeps a separate CLI boundary.

## Read Order

1. [docs/AGENT_REQUIREMENTS.md](docs/AGENT_REQUIREMENTS.md)
2. [README.md](README.md)
3. [~/.shared/skills/t3-threads/SKILL.md](/Users/brad/.shared/skills/t3-threads/SKILL.md)
4. [~/.shared/skills/overseer-thread-management/SKILL.md](/Users/brad/.shared/skills/overseer-thread-management/SKILL.md) when coordinating multiple workers
5. [docs/REMOTE_T3CODE_UPDATE.md](docs/REMOTE_T3CODE_UPDATE.md) when a task looks like remote `t3code.service` maintenance; it routes that work to its real owners

## Purpose

- `t3-thread` is the primary command.
- `t3-agent` is a deprecated compatibility alias only; keep it working for now, but do not use it in new docs, prompts, or examples.
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

- [README.md](README.md)
- [~/.shared/skills/t3-threads/SKILL.md](/Users/brad/.shared/skills/t3-threads/SKILL.md)
- [~/.shared/skills/overseer-thread-management/SKILL.md](/Users/brad/.shared/skills/overseer-thread-management/SKILL.md)
- `/Users/brad/.shared/bin/t3-thread`
- `/Users/brad/.shared/bin/t3-agent` deprecated compatibility alias
- `~/Library/LaunchAgents/network.homenetwork.t3-watcher.plist` if watcher invocation changes

This repo owns worker-thread lifecycle only. Do not add remote release, build, or install procedures here.

- Release/update mechanics for `t3code` are owned by the T3 Code fork: `docs/operations/release.md` and `scripts/headless-auto-upgrade.sh` in `jimprince/t3code`.
- VM, service, pairing, and remote project administration are owned by `/Users/brad/.shared/skills/t3code-remote-ops/SKILL.md`.

[docs/REMOTE_T3CODE_UPDATE.md](docs/REMOTE_T3CODE_UPDATE.md) records that boundary and routes agents to the correct owner.
