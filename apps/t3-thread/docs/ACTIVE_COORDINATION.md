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
- `t3-agent` is a deprecated compatibility alias kept temporarily for old scripts and active threads.
- Runtime state remains in `~/.config/t3-remote-agents/state.json`.
- Creation uses T3 Code's native `thread.turn.start` bootstrap flow.
- T3 chooses and records worktree paths; callers do not pass `--worktree`.
- The watcher plist runs `t3-thread watch --interval 5`.

## Coordination Source

Project/task coordination for target repos may still live in the target repo tracker or in HomeNetwork's historical coordination board. This file records CLI-level state only.

## Active Handoffs

- 2026-05-27: Registered local project `Willow Citrix Hotpatch` at `/Users/brad/Programming/willow-citrix-hotpatch-notes` in `local-mbp`.
  - Project id: `be9f8d66-92aa-407a-b606-00923610bf3b`
  - Worker saved name: `willow-citrix-resume`
  - Thread id: `c2e1f65e-b42c-48f3-bb77-e859b6e9005e`
  - Branch: `t3/willow-citrix-resume`
  - First-turn status: `completed`
  - First-turn finding: helper is running idle; logs show non-Citrix events skipped and helper pastes only into Citrix Viewer, so current evidence does not implicate the helper in non-Citrix double paste.
