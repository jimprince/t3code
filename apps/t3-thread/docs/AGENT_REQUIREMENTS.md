# Agent Requirements

## Current Task Snapshot — Initial Extraction

### Active Requirements
- Standalone project for the T3 worker-thread operator CLI.
- Primary command name: `t3-thread`.
- Compatibility alias: `t3-agent`.
- Keep CLI as a thin wrapper over T3 Code's native thread/bootstrap internals.
- Do not require or recommend caller-managed worktree paths.
- Preserve runtime state compatibility with the existing `~/.config/t3-remote-agents/state.json` unless explicitly migrated later.

### Constraints
- This tracker is the first project file written in the extracted repo.
- Preserve existing HomeNetwork source during extraction; do not delete it in this pass.
- Avoid destructive filesystem operations.

### Acceptance Criteria
- Source, tests, package metadata, and instructions exist in this standalone project.
- `t3-thread` is documented as the primary command.
- `t3-agent` remains available as an alias.
- Shared skills and wrappers route future agents here.

### Status
- In progress.

### Status Update
- Created standalone project at `/Users/brad/Programming/t3-thread`.
- Copied CLI source, tests, TypeScript/Vitest config, and README from HomeNetwork.
- Added standalone `LLM_INSTRUCTIONS.md`, `docs/AGENT_OPERATIONS.md`, and `docs/ACTIVE_COORDINATION.md`.
- Renamed package to `t3-thread` with bin entries for both `t3-thread` and compatibility alias `t3-agent`.
- Updated copied CLI so direct commands like `t3-thread create`, `t3-thread status`, and `t3-thread result` route to the existing lifecycle implementation; legacy nested `agent` commands still work.
- Installed standalone npm dependencies. `npm install` reported four moderate audit findings in transitive dependencies; no forced audit fix was run.
- Updated global wrappers:
  - `/Users/brad/.shared/bin/t3-thread` now points to `/Users/brad/Programming/t3-thread`.
  - `/Users/brad/.shared/bin/t3-agent` now delegates to `t3-thread`.
- Updated launchd watcher plist to run `t3-thread watch --interval 5` from `/Users/brad/Programming/t3-thread`.
- Updated shared thread skills and HomeNetwork migration notes to prefer `t3-thread`.
- Validation not run yet; per operator policy, ask before running build/tests or live CLI checks.

### Packaging Update
- Added package-local bin shims:
  - `bin/t3-thread`
  - `bin/t3-agent`
- Updated `package.json` bin entries to point at those shims instead of requiring a prebuilt `dist/cli.js`.
- The shims run `npm run --silent cli -- ...`, matching the global wrapper behavior and keeping source edits live without a build step.

## Current Task Snapshot — Help and Smoke Polish

### Active Requirements
- Improve `t3-thread --help` so future agents see the direct command forms, not only the legacy nested `agent` command.
- Add a safe smoke script that verifies read-only lifecycle commands without creating threads.
- Do not perform state-path migration or delete the old HomeNetwork source in this pass.

### Constraints
- This tracker update is the first project write for this task.
- Keep changes low-risk and focused.

### Acceptance Criteria
- Top-level help includes direct examples such as `t3-thread create`, `status`, and `result`.
- `npm run smoke` exists and only performs safe read-only checks.

### Status
- In progress.

### Status Update
- Added explicit direct-command help text to `src/cli.ts` for `create`, `status`, `worklog`, `result`, `inbox`, and `watch`.
- Added `npm run smoke`, which performs safe read-only checks:
  - `tsx src/cli.ts envs`
  - `tsx src/cli.ts projects --env local-mbp`
  - `tsx src/cli.ts watch --once --no-deliver`
- Deferred state-path migration and HomeNetwork source cleanup.

### Validation Update
- `npm run smoke` succeeded.
- `t3-thread --help` now shows direct-command guidance and examples.
- Earlier Node one-shot edit attempt failed due shell quoting before code changes; direct patches were applied instead.
- Status: completed.

## Current Task Snapshot — Initialize Git and Push to Gitea

### Active Requirements
- Initialize `/Users/brad/Programming/t3-thread` as a git repository.
- Commit the extracted standalone `t3-thread` CLI project.
- Create or use a Gitea repository named `t3-thread`.
- Add the Gitea repository as `origin` and push `main`.

### Constraints
- First project write for this task is this tracker update.
- Do not delete or rewrite existing HomeNetwork source.
- Use Gitea API/HTTP workflow rather than GitHub CLI.

### Acceptance Criteria
- Local repo has an initial commit on `main`.
- `origin` points at the Gitea `t3-thread` repo.
- `main` is pushed to Gitea.

### Status
- In progress.

### Git/Gitea Preparation
- Added `.gitignore` so generated dependencies and build outputs are not committed.
- Target Gitea remote: `ssh://git@git.home:2222/brad/t3-thread.git`.
