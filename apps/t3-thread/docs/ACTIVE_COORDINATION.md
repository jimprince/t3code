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
- The notification watcher is on-demand by default: `create`/`subscribe` ensure a singleton watcher process when notifications are configured, and the watcher exits after its idle window when nothing is in flight. The launchd plist is optional/manual only.

## Coordination Source

Project/task coordination for target repos may still live in the target repo tracker or in HomeNetwork's historical coordination board. This file records CLI-level state only.

## Recent Retired Work

- 2026-06-18: Retired stale saved worker mappings/subscriptions after direct raw thread UUID lifecycle-command support was folded into the local dirty cleanup.
  - Project id: `6ad68f3a-4431-4121-ab23-4d431fce6c9f`
  - Worker saved name: `t3-thread-uuid-direct`
  - Thread id: `ddbd58d0-6b5b-4036-a599-d4240a998600`
  - Branch: `t3/raw-thread-id-direct`
  - Cleanup: `t3-thread forget t3-thread-uuid-direct` removed the stale saved mapping and related source subscription.

## Active Handoffs

- 2026-06-01: Registered local project `K1 CFS Open MMU` at `/Users/brad/Programming/k1-cfs-open-mmu` in `local-mbp`.
  - Project id: `dbad92eb-0b76-4818-90c7-fdc576652235`
  - Worker saved name: `k1-cfs-open-mmu-handoff`
  - Thread id: `c313ba2a-9b66-4b69-b7b8-02e334703d9f`
  - Branch: none; target folder is not currently a git repository, so T3 created a normal project thread rather than a branch-pinned worktree.
  - First-turn status: `completed`; session status: `ready`
  - First-turn finding: worker performed read-only orientation, made no file/printer changes, confirmed unsafe `CFS_WIPE_NOZZLE` purge-station X-motion remains the active blocker, and recommended the next supervised step be disabling that call/no-oping `BOX_NOZZLE_CLEAN` before any print/toolchange retry.

- 2026-06-01: Registered local project `Ice` at `/Users/brad/Programming/Ice` in `local-mbp`.
  - Project id: `3f22d089-cf55-49ed-ab93-c6affc99a85b`
  - Worker saved name: `ice-menu-bar-handoff`
  - Thread id: `5e3f4e94-01fe-4375-a3bc-7de57951fd0b`
  - Branch: `t3/ice-menu-bar-handoff`
  - Initial status: `running`
  - Handoff note: the live Ice checkout contains uncommitted local patches; the worker was instructed to inspect `/Users/brad/Programming/Ice/docs/AGENT_REQUIREMENTS.md`, `git status`, and `git diff` in the live checkout before deciding whether to keep, refine, or revert patches.

- 2026-05-28: Registered remote project `Protein Functional Topology` at `/home/brad/Programming/protein-functional-topology` in `dev-vm`.
  - Project id: `9320c6c9-52a2-4082-900d-82cd0861ac9d`
  - Worker saved name: `pft-phase-0-1`
  - Thread id: `e90614fc-e662-495c-9e39-e5dc45114340`
  - Branch: `t3/phase-0-1-euclidean-mvp`
  - First-turn status: `completed`; session status: `running`
  - First-turn finding: worker read the handover, confirmed it will inspect the repo, choose the smallest runnable stack, and update `docs/AGENT_REQUIREMENTS.md` before implementation writes.

- 2026-05-27: Registered local project `Markdown Vault Web` at `/Users/brad/Programming/markdown-vault-web` in `local-mbp`.
  - Project id: `8fade5e4-f889-4c50-9dd9-3a183b09cd86`
  - Worker saved name: `markdown-vault-handoff`
  - Thread id: `ea48ee18-64b2-4c0b-b508-64ddd68b14aa`
  - Branch: `t3/markdown-vault-handoff`
  - First-turn status: `completed`
  - First-turn finding: worker loaded the live dirty checkout at `/Users/brad/Programming/markdown-vault-web`, read repo instructions/tracker, noted dirty tracked/untracked files, and is ready for the next user request.

- 2026-05-27: Registered local project `Willow Citrix Hotpatch` at `/Users/brad/Programming/willow-citrix-hotpatch-notes` in `local-mbp`.
  - Project id: `be9f8d66-92aa-407a-b606-00923610bf3b`
  - Worker saved name: `willow-citrix-resume`
  - Thread id: `c2e1f65e-b42c-48f3-bb77-e859b6e9005e`
  - Branch: `t3/willow-citrix-resume`
  - First-turn status: `completed`
  - First-turn finding: helper is running idle; logs show non-Citrix events skipped and helper pastes only into Citrix Viewer, so current evidence does not implicate the helper in non-Citrix double paste.
