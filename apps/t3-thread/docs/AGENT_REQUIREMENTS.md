# Agent Requirements

## Current Task Snapshot — Child Completion Notification Reliability

### Active Requirements
- Investigate why a parent/original T3 thread subscribed for child completion notifications does not reliably receive a notification when the child completes.
- Orient against the intended behavior documented in `LLM_INSTRUCTIONS.md`, `docs/AGENT_OPERATIONS.md`, `docs/ACTIVE_COORDINATION.md`, and `~/.shared/skills/t3-threads/SKILL.md`.
- Determine whether the root cause is in watcher lifecycle, subscription persistence, event detection, or delivery.
- Reproduce the failure path if feasible.
- Propose a fix and implement it if confidence is high and validation passes.
- Preserve existing thread-to-thread notification routing semantics.
- Rebuild committed `dist/cli.js` after any `src/` change.
- Run `npm test` and report exact results.
- Commit the completed work on branch `t3/fix-completion-notify` with a clear message.

### Constraints
- This tracker update is the first project write for this task.
- Do not hand-edit `~/.config/t3-remote-agents/state.json` as a fix.
- Keep `t3-thread` a thin wrapper over native T3 APIs.
- Do not break existing notification routing for thread-to-thread cases.
- Avoid destructive git operations and preserve unrelated work.

### Acceptance Criteria
- Root cause is identified with concrete file/line evidence.
- Reproduction steps clearly state observed vs expected behavior if repro is possible.
- Any implemented fix is covered by regression tests.
- `npm run build` is run after `src/` changes and committed `dist/cli.js` is refreshed.
- `npm test` passes, or any failure is reported exactly.
- A commit exists on `t3/fix-completion-notify` with the completed fix or investigation result.

### Status
- Completed locally.

### Validation Update
- Root cause confirmed in the create/subscribe and watch command paths: subscriptions were persisted, but no on-demand watcher bootstrap or singleton idle-exit lifecycle existed in the implementation.
- Added watcher bootstrap helpers and wired `create`/`subscribe` to best-effort spawn a singleton detached watcher when a notification route is attached.
- Added watcher idle-work detection so the watcher stays alive while subscribed source threads are still running or undelivered notifications remain.
- Added regression coverage for watcher-work detection and watcher singleton lease handling.
- Updated `README.md` and `docs/AGENT_OPERATIONS.md` to document the on-demand watcher lifecycle and `watch --ensure` usage.
- `npm ci` completed successfully in this worktree.
- `npm test -- watch watcher-process` passed: 8 tests across 2 files.
- `npm run build` passed and refreshed `dist/cli.cjs`.
- `npm test` passed: 83 tests across 11 files.

## Current Task Snapshot - Protein Functional Topology Handoff Registration

### Active Requirements
- Register `/home/brad/Programming/protein-functional-topology` as a project in the remote `dev-vm` T3 Code environment.
- Create a real T3 worker thread for the Protein Functional Topology Phase 0/1 handoff.
- Verify creation with a returned remote `threadId` and status check.
- Record the active project/thread handoff state for future agents.

### Constraints
- Use `t3-thread`, not the deprecated `t3-agent` command.
- Do not fabricate a thread id; a worker exists only after `t3-thread create` returns `threadId`.
- Preserve the target repo's active T3 worktree metadata after thread creation.

### Acceptance Criteria
- `dev-vm` contains a T3 project for `/home/brad/Programming/protein-functional-topology`.
- Saved worker `pft-phase-0-1` exists with a real thread id.
- `t3-thread status pft-phase-0-1` reports a non-error state.
- `docs/ACTIVE_COORDINATION.md` records the live handoff state.

### Status
- Completed: project id `9320c6c9-52a2-4082-900d-82cd0861ac9d`; worker `pft-phase-0-1`; thread id `e90614fc-e662-495c-9e39-e5dc45114340`; first turn completed and worker acknowledged the handoff.

## Current Task Snapshot - Willow Citrix Handoff Registration

### Active Requirements
- Register `/Users/brad/Programming/willow-citrix-hotpatch-notes` as a project in the local T3 Code environment.
- Create a real T3 worker thread for the Willow/Citrix hotpatch handoff.
- Verify creation with a returned remote `threadId` and status check.
- Record the active project/thread handoff state for future agents.

### Constraints
- Use `t3-thread`, not the deprecated `t3-agent` command.
- Do not fabricate a thread id; a worker exists only after `t3-thread create` returns `threadId`.
- Keep the Willow handoff free of transcript contents or sensitive dictated text.

### Acceptance Criteria
- `local-mbp` contains a T3 project for `/Users/brad/Programming/willow-citrix-hotpatch-notes`.
- Saved worker `willow-citrix-resume` exists with a real thread id.
- `t3-thread status willow-citrix-resume` reports a non-error state.
- `docs/ACTIVE_COORDINATION.md` records the live handoff state.

### Status
- Completed: project id `be9f8d66-92aa-407a-b606-00923610bf3b`; worker `willow-citrix-resume`; thread id `c2e1f65e-b42c-48f3-bb77-e859b6e9005e`; first turn completed.

## Current Task Snapshot — OpenCode Antigravity Thread Model Validation

### Active Requirements
- Check whether `t3-thread` can launch real T3 worker threads using OpenCode through Antigravity with Gemini 3.5 Flash High.
- Check whether `t3-thread` can launch real T3 worker threads using OpenCode through Antigravity with Gemini 3.5 Flash Low/Medium.
- Use the OpenCode model aliases through OpenCode's required `provider/model` syntax: `google/antigravity-gemini-3.5-flash-high` and `google/antigravity-gemini-3.5-flash-low`.
- If the local `t3-thread` CLI blocks current T3 snapshots containing `opencode` model selections, fix the compatibility issue narrowly.
- Verify with real `t3-thread create` calls and report the created thread ids/status.

### Constraints
- This tracker update is the first project write for this task.
- Keep `t3-thread` a thin wrapper over T3 Code native APIs.
- Preserve existing Codex and Claude thread behavior.
- Avoid printing secrets or Antigravity credentials.
- Do not use Codex built-in subagents.

### Acceptance Criteria
- `t3-thread projects --env local-mbp` can decode snapshots containing `opencode` model selections.
- A high test thread can be created with `--provider opencode --model google/antigravity-gemini-3.5-flash-high`.
- A low test thread can be created with `--provider opencode --model google/antigravity-gemini-3.5-flash-low`.
- Each test thread reaches a non-error status or any provider/runtime failure is captured from `worklog`.

### Status
- Completed locally; now syncing the validated OpenCode support by committing,
  rebasing onto `origin/main`, rerunning validation, pushing, and updating the
  dev VM checkout.

### Validation Update
- Added `opencode` as an accepted T3 provider/model-selection kind in the vendored contract layer.
- Added OpenCode model defaults and aliases that normalize to OpenCode's required `google/<model>` format for project defaults and thread creation.
- During VM sync, found the local build had been produced from stale installed
  transitive packages; refreshed local `node_modules` so `dist/cli.cjs` is built
  against the committed audit overrides (`ws@8.20.1`, `uuid@13.0.1`).
- Confirmed `t3-thread projects --env local-mbp` decodes snapshots containing existing `opencode` thread model selections.
- Created high smoke thread `opencode-35-high-google-smoke` with thread id `d2bf4521-91dc-4688-ad4b-c7bbd4e929ad`; result text was `OK_HIGH_T3`.
- Created low smoke thread `opencode-35-low-google-smoke` with thread id `ed26bb8c-aae0-4606-94e6-57af9a423d0b`; result text was `OK_LOW_T3`.
- Before CLI normalization was added, bare aliases without the `google/` prefix created thread shells but the OpenCode adapter rejected the turn with `OpenCode model selection must use the 'provider/model' format.`
- Updated README, operations docs, and the shared `t3-threads` skill to show the required OpenCode slug format.
- Validation passed: `npm run test -- projects orchestration-model-options-compat`, `npm run build`, `npm run test -- dist-freshness`, and `npm test`.

## Current Task Snapshot — T3 Project Management CLI

### Active Requirements
- Add first-class `t3-thread project` management commands for paired T3 Code environments.
- Support managing both local and remote projects through the same saved `--env` model used for threads.
- Keep `t3-thread projects --env <name>` as the existing list shortcut.
- Add canonical singular commands: `project list`, `project add`, `project rename`, `project set-model`, and `project remove`.
- Use T3 Code's existing orchestration RPC commands as the primary implementation path.
- Keep SSH-based `t3 project ...` workflows as fallback documentation only, not routine CLI behavior.
- Require explicit safety flags for potentially surprising mutations: `--create-dir` for missing add paths and `--force` for removing projects with active threads.
- Require absolute project paths to avoid local-vs-remote ambiguity.
- Rebuild committed distribution output if source changes require it.
- Update repo docs and shared T3 skills so future agents discover the new project workflow.
- Run focused tests, full tests, dist freshness validation, and live/smoke CLI validation where feasible.

### Constraints
- This tracker update is the first project write for this task.
- Keep `t3-thread` a thin wrapper over T3 Code native APIs.
- Preserve existing thread lifecycle behavior and command compatibility.
- Preserve the remote repo state and avoid destructive git operations.
- Do not remove the deprecated `t3-agent` alias.

### Acceptance Criteria
- `t3-thread project list --env dev-vm` lists remote projects.
- `t3-thread projects --env dev-vm` continues to work.
- `t3-thread project add --env <env> --path <absolute-path>` dispatches `project.create`.
- `project add` rejects relative paths and missing paths unless `--create-dir` is passed.
- `project rename` dispatches `project.meta.update` for title changes.
- `project set-model` dispatches `project.meta.update` for `defaultModelSelection`, including `--clear`.
- `project remove` dispatches `project.delete` and rejects active-thread removal unless `--force` is passed.
- Project target resolution by id and exact workspace root works, and duplicate workspace roots require id.
- Regression tests cover command payloads and safety behavior.
- Updated docs and shared skills describe the new workflow.

### Status
- Completed locally.

### Validation Update
- Added pure project-management helpers in `src/projects.ts`.
- Added `t3-thread project list/add/rename/set-model/remove` in the CLI while preserving `t3-thread projects --env <name>`.
- Added RPC client methods for project create, rename, default-model update/clear, and remove.
- Updated vendored orchestration command decoding so `project.delete` accepts `force`.
- Updated README, operations docs, and shared T3 skills with the new project-management workflow.
- `npm ci` completed; npm reported two moderate transitive audit findings and no dependency changes were made.
- `npm run test -- projects` passed: 19 tests.
- `npm run test -- projects orchestration` passed: 23 tests.
- `npm run build` passed.
- `npm run test` passed: 70 tests.
- `npm run test -- dist-freshness` passed: 1 test.
- `t3-thread project --help` showed the new command group.
- `t3-thread project list --env dev-vm` and existing `t3-thread projects --env dev-vm` both listed projects.
- Live `dev-vm` smoke passed using `/tmp/t3-thread-project-smoke-20260520143904`: add with `--create-dir`, rename, set model, clear model, remove, and final list confirmed the smoke project was no longer active.
- `npx tsc --noEmit` is not a valid repo check in the current configuration because existing vendored contract files lack NodeNext `.js` import extensions and have pre-existing type errors; one new type issue surfaced by that run was fixed before normal validation.
- Fresh-agent validation via `subagents codex` passed: a new agent found the repo/shared docs and reported the canonical `t3-thread project` commands plus the preserved `projects --env` shortcut without hidden parent-session context.

## Current Task Snapshot — Audit Dependency Fix

### Active Requirements
- Resolve the current `npm audit` findings in `t3-thread` for transitive `uuid@13.0.0` and `ws@8.20.0`.
- Prefer bumping the Effect package family together if that naturally updates the vulnerable transitive packages.
- If package bumps do not resolve the findings, use targeted npm overrides for `uuid@13.0.1` and `ws@8.20.1`.
- Keep the CLI behavior unchanged.

### Constraints
- This tracker update is the first project write for this task.
- Avoid forced audit fixes that introduce unrelated dependency churn.
- Preserve the remote repo state and avoid destructive git operations.

### Acceptance Criteria
- `npm audit` reports zero vulnerabilities.
- `npm run build` succeeds.
- `npm test` succeeds.
- `t3-thread --help` still runs.

### Status
- Completed using targeted npm overrides for `uuid@13.0.1` and `ws@8.20.1` while keeping the existing Effect `4.0.0-beta.45` dependency line.
- Validation passed: `npm run build`, `npm test` (56 tests), `npm audit` (0 vulnerabilities), and `t3-thread --help`.

## Current Task Snapshot — Caller Environment Metadata

### Active Requirements
- Update `t3-thread caller` and notification caller resolution to consume
  `T3_ENVIRONMENT_ID` / `T3_ENVIRONMENT_NAME` when present alongside
  `T3_THREAD_ID`.
- Prefer explicit environment context over scanning every saved environment.
- Return an unsaved caller payload like
  `{ "threadId": "...", "environment": "local-mbp", "saved": false }`, mapping
  env id/name/label back to the saved environment key used for routing.
- Preserve the existing saved-agent resolution behavior when the current thread
  id is saved locally.
- Preserve fallback paired-environment scanning when the new metadata is not
  present.
- Add focused regression tests for env-provided caller environment resolution.
- Rebuild committed distribution output if source changes require it.
- Verify the focused tests and live `t3-thread caller` behavior in this session.

### Constraints
- This tracker update is the first project write for this task.
- Keep `t3-thread` a thin wrapper over T3 Code native APIs.
- Preserve existing state format compatibility.
- Preserve existing user work and avoid destructive git operations.

### Acceptance Criteria
- `resolveCallerThreadId` still reads trimmed `T3_THREAD_ID`.
- A new caller resolver reads `T3_ENVIRONMENT_NAME`/`T3_ENVIRONMENT_ID` and
  returns an unsaved endpoint without remote environment scanning when possible.
- Caller subscription during `t3-thread create` can use the env-provided caller environment.
- Existing saved-agent lookup remains preferred over raw environment metadata.
- Fallback scanning still works when environment metadata is absent.
- Tests cover direct metadata, saved-agent preference, environment id matching,
  environment name/label matching, and missing metadata.
- Focused tests, build/dist freshness, and relevant docs are updated.

### Status
- Completed locally.

### Validation Update
- Added caller environment metadata parsing for `T3_ENVIRONMENT_ID` and `T3_ENVIRONMENT_NAME`.
- Caller endpoint resolution now prefers saved agent mappings, then maps env id/name/label to the saved environment key before falling back to paired-environment scanning.
- Updated `t3-thread caller`, default create notification resolution, `subscribe`, and `unsubscribe` caller paths to pass env metadata into resolution.
- Added regression tests for complete/incomplete env metadata, saved-agent precedence, environment id matching, environment label matching, saved-name matching, and missing metadata fallback.
- Updated README, operations runbook, and shared `t3-threads` skill routing notes.
- `npm run test -- state` passed: 21 tests.
- `npm run build` passed and updated `dist/cli.cjs`.
- `npm run test -- state dist-freshness` passed: 22 tests.
- `npm run test` passed: 57 tests across 9 files.
- `npm run --silent cli -- caller` returned the current unsaved caller with `environment: "local-mbp"` and `saved: false`.

## Current Task Snapshot — Legacy Schema Decode Compatibility

### Active Requirements
- Fix the `t3-thread` CLI/contracts decode path so normal commands no longer require direct-RPC workarounds when T3 backends return legacy shell snapshot payloads.
- Support legacy project `defaultModelSelection` values shaped like `{"instanceId":"codex","model":"gpt-5.4"}`.
- Support legacy thread `modelSelection` values shaped like `{"instanceId":"codex","model":"gpt-5.5","options":[{"id":"reasoningEffort","value":"medium"}]}`.
- Support legacy/current model selection payloads that include `options` arrays without failing schema decode.
- Confirm `subscribeShell` stream items with `kind:"snapshot"` decode correctly and are not rejected as non-event stream items.
- Add regression tests using the exact legacy payload shapes from the failure examples.
- Rebuild committed distribution output if source changes require it.
- Run focused tests and a smoke command where feasible.
- Commit the completed changes and report the commit SHA, changed files, tests run, and any follow-up.

### Constraints
- This tracker update is the first project write for this task.
- Do not change T3 server code.
- Keep `t3-thread` a thin wrapper over T3 Code native APIs.
- Preserve existing user work and avoid destructive git operations.

### Acceptance Criteria
- `t3-thread projects --env local-mbp` can decode shell snapshots with legacy `defaultModelSelection`.
- `t3-thread create ...` can proceed past project snapshot decoding for legacy model selections.
- `t3-thread status <agent>` can decode thread snapshots with legacy `modelSelection` and `options`.
- `subscribeShell` snapshot stream items decode as valid snapshots.
- Regression tests fail without the compatibility normalization and pass with it.
- Focused tests, build/dist freshness, and smoke validation are run or any infeasible command is documented.

### Status
- Completed locally.

### Validation Update
- Existing vendored contract layer already contains backward-compatible `instanceId` model-selection normalization and legacy `options` array normalization in `src/vendor/t3contracts/orchestration.ts`.
- Added regression coverage for the exact legacy `subscribeShell` project `defaultModelSelection` shape: `{"instanceId":"codex","model":"gpt-5.4"}`.
- Added regression coverage for the exact legacy `subscribeThread` status snapshot shape: `{"instanceId":"codex","model":"gpt-5.5","options":[{"id":"reasoningEffort","value":"medium"}]}`.
- Confirmed the regressions fail when the legacy `instanceId` decoder is temporarily removed, then pass after restoring it.
- `npm run test -- orchestration-model-options-compat` passed: 4 tests.
- `npm run build` passed and did not change `dist/cli.cjs`.
- `npm run test -- dist-freshness` passed: 1 test.
- `npm run test` passed: 51 tests.
- `npm run smoke` passed, including `tsx src/cli.ts projects --env local-mbp`.

## Current Task Snapshot — Deprecate T3-Agent Naming

### Active Requirements
- Keep `t3-agent` executable alias in place for compatibility during one or two releases.
- Rename current docs, prompts, tests, and shared agent guidance to use `t3-thread` as the canonical command.
- Mark `t3-agent` as legacy/deprecated compatibility only.
- Avoid breaking old active worker threads that may still have `t3-agent` in history.

### Constraints
- This tracker update is the first project write for this task.
- Do not remove the `t3-agent` alias yet.
- Keep runtime behavior equivalent except for canonical wording and orientation.

### Acceptance Criteria
- New worker preamble instructs `t3-thread send`, not `t3-agent agent send`.
- Help/shared docs prefer `t3-thread`.
- Remaining `t3-agent` references are only compatibility/deprecation notes, bin alias entries, or non-user-facing test temp names.
- Tests pass after wording updates.

### Status
- Completed locally.

### Validation Update
- Updated current docs, shared guidance, CLI help, and worker preamble to prefer `t3-thread`.
- Kept `t3-agent` package/global alias in place as deprecated compatibility.
- Rebuilt `dist/cli.cjs` with `npm run build`.
- `npm run test -- thread-preamble dist-freshness` passed: 7 tests.
- `npm run test` passed: 49 tests.
- `npm run smoke` passed.

### Remote Verification Follow-Up
- Dev VM pull succeeded.
- Remote focused test exposed that `tests/dist-freshness.test.ts` expects committed `dist/cli.cjs`, while `.gitignore` excluded `dist/`.
- Track only `dist/cli.cjs` so fresh clones and the dev VM can run the same test suite without relying on an untracked local build artifact.
- Align `package.json` package bin entries with `package-lock.json`: package-style installs use the committed `dist/cli.cjs`; repo-local wrappers still exist for source-backed development.

## Current Task Snapshot — Initial Extraction

### Active Requirements
- Standalone project for the T3 worker-thread operator CLI.
- Primary command name: `t3-thread`.
- Deprecated compatibility alias: `t3-agent`.
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
- `t3-agent` remains available as a deprecated compatibility alias.
- Shared skills and wrappers route future agents here.

### Status
- Completed.

### Status Update
- Added compatibility decoding for `instanceId`/`model` model selections in shell snapshots.
- Added regression coverage for instanceId-shaped project and thread model selections.
- Verified with `npm run test -- orchestration-model-options-compat` and `npm run build`.
- Confirmed `t3-thread projects --env dev-vm` lists remote projects again.
- Registered `/home/brad/Programming/t3code-fork` as remote project `a50f5bdb-01be-4dea-8359-6959ac86a277`.
- Created real T3 worker `t3code-upstream-sync-repair` with remote thread id `1e537256-51f0-4be0-8fae-904a6b6b5b21`.

### Status Update
- Created standalone project at `/Users/brad/Programming/t3-thread`.
- Copied CLI source, tests, TypeScript/Vitest config, and README from HomeNetwork.
- Added standalone `LLM_INSTRUCTIONS.md`, `docs/AGENT_OPERATIONS.md`, and `docs/ACTIVE_COORDINATION.md`.
- Renamed package to `t3-thread` with bin entries for both `t3-thread` and deprecated compatibility alias `t3-agent`.
- Updated copied CLI so direct commands like `t3-thread create`, `t3-thread status`, and `t3-thread result` route to the existing lifecycle implementation; legacy nested `agent` commands still work.
- Installed standalone npm dependencies. `npm install` reported four moderate audit findings in transitive dependencies; no forced audit fix was run.
- Updated global wrappers:
  - `/Users/brad/.shared/bin/t3-thread` now points to `/Users/brad/Programming/t3-thread`.
  - `/Users/brad/.shared/bin/t3-agent` now delegates to `t3-thread`.
- Updated launchd watcher plist to run `t3-thread watch --interval 5` from `/Users/brad/Programming/t3-thread`.
- Updated shared thread skills and HomeNetwork migration notes to prefer `t3-thread`.
- Validation not run yet; per operator policy, ask before running build/tests or live CLI checks.

### Packaging Update
- Added package-local development shims:
  - `bin/t3-thread`
  - `bin/t3-agent`
- Package-style bin entries now point at the committed `dist/cli.cjs` bundle.
- The repo-local and shared shims still run `npm run --silent cli -- ...`, matching the global wrapper behavior and keeping source edits live without a build step.

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

## Current Task Snapshot — Remote T3 Code Update Runbook

### Active Requirements
- Add a skill or runbook that explains how to update the remote dev VM's `t3code`/`t3` version.
- Link the new operational documentation from `LLM_INSTRUCTIONS.md`.

### Constraints
- This tracker update is the first project write for this task.
- Keep the guidance concise and operational.
- Use canonical local-network values from `~/.shared/config/local_network.env`; do not hardcode secrets.
- Preserve the distinction between remote `t3code.service` substrate maintenance and `t3-thread` worker lifecycle operations.

### Acceptance Criteria
- Future agents can find the remote update procedure from `LLM_INSTRUCTIONS.md`.
- The procedure covers updating from Brad's fork, building/installing the CLI on the dev VM, restarting the service, verification, and known failure modes.

### Status
- Completed.

### Status Update
- Added `docs/REMOTE_T3CODE_UPDATE.md` with the remote dev VM update workflow for Brad's `jimprince/t3code` fork.
- Linked the runbook from `LLM_INSTRUCTIONS.md` read order and maintenance guidance.
- Added the runbook to the README docs list.
- Verification performed by inspecting the new runbook and linked docs; no code tests were needed for this docs-only change.

## Current Task Snapshot — Current Thread Cleanup Documentation

### Active Requirements
- Document the safe cleanup pattern used after troubleshooting a stuck T3 thread.
- Preserve the key operational nuance: when replying from the thread being cleaned up, do not archive that T3 thread before the final response lands.

### Constraints
- This tracker update is the first project write for this task.
- Keep the documentation small and place it in the existing operational runbook.
- Do not change CLI behavior.

### Acceptance Criteria
- Future agents can find the procedure in `docs/AGENT_OPERATIONS.md`.
- The documented flow distinguishes remote thread archival from local Git worktree/branch cleanup.

### Status
- Completed.

### Status Update
- Added the current-thread cleanup sequence to `docs/AGENT_OPERATIONS.md`.
- Documented the rule to leave the current T3 thread unarchived until its final response lands.
- No CLI behavior changes were needed.

## Current Task Snapshot — Model Selection Snapshot Compatibility

### Active Requirements
- Unblock creating a real remote T3 Code worker thread for `/home/brad/Programming/t3code-fork` on `dev-vm`.
- Fix `t3-thread` snapshot decoding so it accepts the current remote T3 Code `defaultModelSelection` / `modelSelection` shape using `instanceId` and `model`.
- Launch the T3 worker only through the canonical `t3-thread create` flow and confirm the returned remote `threadId`.

### Constraints
- This tracker update is the first project write for this compatibility-fix task.
- Preserve existing unrelated dirty documentation changes in this repo.
- Do not fabricate thread ids or bypass T3 thread lifecycle state.

### Acceptance Criteria
- `t3-thread projects --env dev-vm` can list projects without the snapshot schema error.
- A worker thread is created on the remote dev VM for the T3 Code fork maintenance task.
- The saved agent name and remote `threadId` are recorded in the handoff response.

### Status
- Completed.

### Status Update
- Reviewed the dirty main-checkout changes in a branch-pinned worktree and reconstructed the compatibility, test, and docs changes without editing the dirty source checkout during implementation.
- Installed worktree dependencies with `npm ci` so validation could run locally.
- Validation passed with `npm run test`, `npm run build`, and `npm run smoke`.

## Current Task Snapshot — Review Dirty Main Checkout, Fix, Commit, Merge, Push

### Active Requirements
- Review the current dirty changes in `/Users/brad/Programming/t3-thread`.
- Reconstruct the needed changes in this branch-pinned worktree instead of editing the dirty main checkout during implementation.
- Preserve user work; do not drop or revert dirty main-checkout changes without recording a clear reason here first.
- Ensure snapshot decoding remains compatible with newer T3 Code `modelSelection` / `defaultModelSelection` payloads that use `instanceId` and `model`.
- Review the dirty docs additions and keep, adjust, or split them logically as part of publishing.
- Run at minimum `npm run test`, `npm run build`, and any repo freshness/smoke checks needed by current scripts/docs.
- Commit logically, merge the finished branch to `main`, and push `origin/main`.

### Constraints
- This tracker update is the first repo file edit for this task in the worktree.
- Do not edit `/Users/brad/Programming/t3-thread` directly during implementation unless needed at the final merge/push step.
- Do not use destructive git commands or hand-edit `~/.config/t3-remote-agents/state.json`.
- Keep `t3-thread` a thin wrapper over T3 Code native bootstrap semantics.

### Acceptance Criteria
- The worktree contains the reviewed compatibility fix, regression tests, and any approved docs updates from the dirty main checkout.
- Validation passes or any unavoidable failures are explicitly documented.
- One or more commits capture the finalized changes cleanly.
- `main` is updated from the committed worktree changes and pushed to `origin/main` without losing dirty user state.

### Status
- Completed.

### Review Notes
- Source material is the dirty main checkout on `main`, which currently modifies:
  - `LLM_INSTRUCTIONS.md`
  - `README.md`
  - `docs/AGENT_OPERATIONS.md`
  - `docs/AGENT_REQUIREMENTS.md`
  - `src/vendor/t3contracts/orchestration.ts`
  - `tests/orchestration-model-options-compat.test.ts`
  - untracked `docs/REMOTE_T3CODE_UPDATE.md`
- Planned publishing split under review:
  - compatibility code + regression tests
  - operator docs/runbook additions

### Validation Update
- `npm ci` completed successfully in the worktree; one moderate audit vulnerability remains in dependencies and was not changed in this task.
- `npm run test` passed: 9 files, 49 tests.
- `npm run build` passed and refreshed `dist/cli.cjs` deterministically with no tracked diff.
- `npm run smoke` passed.

### Publish Plan
- Keep the compatibility fix and operator docs as separate conventional commits for cleaner history.

## Current Task Snapshot — Markdown Vault Web Handoff Thread

### Active Requirements
- Register `/Users/brad/Programming/markdown-vault-web` as a T3 Code project if it is missing.
- Create a real T3 worker thread that can continue the current Markdown Vault Web conversation without losing context.
- Include enough handoff detail for the worker to treat the live dirty checkout as the source of truth.

### Constraints
- This tracker update is the first `t3-thread` repo write for this coordination-record task.
- Do not hand-edit T3 runtime state; use `t3-thread` CLI commands.
- Preserve the Markdown Vault Web repo's dirty state.

### Acceptance Criteria
- Project registration returns a real project id.
- Thread creation returns a real remote `threadId`.
- Initial status/result confirms the worker read the live checkout and is ready for the next request.

### Status
- Completed.
