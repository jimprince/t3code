# Agent Requirements

## Current Task: Fix Nightly Release Build After Goal Command

Troubleshoot and fix the failed nightly release build that prevented the `/goal`
changes from being published in a downloadable build.

### Current User Requirements

- Determine whether the current nightly build includes the `/goal` command.
- Troubleshoot the failed release build.
- Fix the release-blocking failure so a new nightly can publish with `/goal`.

### Constraints

- Follow repo instructions: use `bun run test`, never `bun test`; all of
  `bun fmt`, `bun lint`, and `bun typecheck` must pass before completion when
  code changes require them.
- Do not delete remote releases or tags unless explicitly confirmed.
- Preserve the `/goal` implementation behavior; only fix release/test fallout.

### Acceptance Criteria

- The release-blocking failing tests pass locally.
- Required repo checks pass locally.
- The fix is committed and pushed to GitHub.
- A new release workflow run is started or the release path is clearly handed
  off with exact next command.

### Status

- Local fix verified; ready to commit and push.

### Verification

- Release failure identified in GitHub Actions run `26731273031`: full server
  tests failed because expected thread snapshots omitted the new `goal: null`
  read-model field.
- Focused reproduction before patch failed in
  `apps/server/src/orchestration/projector.test.ts` and
  `apps/server/src/orchestration/Layers/ProjectionSnapshotQuery.test.ts`.
- Focused tests now pass:
  `bun run --filter t3 test -- src/orchestration/projector.test.ts src/orchestration/Layers/ProjectionSnapshotQuery.test.ts`.
- Required checks pass locally: `bun fmt`, `bun lint` (warnings only),
  `bun typecheck`, and `bun run test`.

### Open Questions / Proposed Changes

- None.

## Current Task: Recheck Orchestration External Event Catch-Up Fix

Validate and, if appropriate, implement the fix for a running server rejecting
`thread.create` after a project was created by another process.

### Current User Requirements

- Double-check the proposed orchestration read-model catch-up fix.
- Continue with next steps if the path is clear.
- Implement a repo fix if the failure is confirmed in the repo.
- Commit, merge, and push the verified fix.

### Constraints

- Keep the fix scoped to orchestration command read-model consistency.
- Preserve command idempotency and existing receipt behavior.
- Follow repo instructions: use `bun run test`, never `bun test`; all of
  `bun fmt`, `bun lint`, and `bun typecheck` must pass before completion when
  code changes require them.

### Acceptance Criteria

- A running `OrchestrationEngine` catches up command state before deciding a
  command when events were appended/projected outside that engine instance.
- `thread.create` succeeds for a project added externally after engine
  bootstrap.
- Focused regression coverage proves the stale in-memory command read model
  failure path.
- The fix commit is merged to the intended branch and pushed to GitHub.

### Status

- Implementation verified; commit/merge/push in progress.

### Verification

- Passed: focused regression test
  `bun run --filter t3 test -- src/orchestration/Layers/OrchestrationEngine.test.ts -t "catches up command state"`.
- Verified regression catch: temporarily removed the pre-decision catch-up and
  the focused test failed with the missing-project invariant.
- Passed: full orchestration engine test file
  `bun run --filter t3 test -- src/orchestration/Layers/OrchestrationEngine.test.ts`.
- Passed: `bun fmt`.
- Passed: `bun lint` with existing unrelated warnings only.
- Passed: `bun typecheck`.
- Pending: post-push branch verification.

## Current Task: Add T3 Code Goal Command

Implement a T3 Code `/goal` command similar to Claude Code's goal loop, using
T3-native orchestration rather than provider-specific slash-command passthrough.

### Current User Requirements

- Implement `/goal` for T3 Code based on the researched Claude Code/Gemini
  behavior and the proposed detailed implementation plan.
- `/goal <condition>` must set an active completion goal and start work toward
  it.
- `/goal` must expose current goal status without sending a provider turn.
- `/goal clear|stop|off|reset|none|cancel` must clear the active goal without
  sending a provider turn.
- After each completed provider turn, T3 Code should evaluate whether the active
  goal is satisfied and continue with another turn when it is not.
- The evaluator must judge only transcript-visible evidence.
- Goal state must be represented in T3 orchestration state so the web UI can
  reconnect without losing visibility.

### Constraints

- Follow repo instructions: `bun fmt`, `bun lint`, and `bun typecheck` must pass
  before completion.
- Never run `bun test`; use `bun run test` or package test scripts for Vitest.
- Keep the goal loop server-side and provider-agnostic where practical.
- Do not silently continue when a thread is blocked on approval, user input, or
  provider/session error.
- Avoid runaway loops with explicit server-side caps.

### Acceptance Criteria

- Built-in slash command parsing and menu support `/goal` while preserving
  existing `/model`, `/plan`, and `/default` behavior.
- Setting a goal records persisted thread goal state and dispatches the initial
  provider turn.
- Status and clear subcommands are handled locally/orchestrationally and do not
  reach the provider as normal prompts.
- Goal evaluation records the latest reason and marks the goal achieved when
  the transcript proves the condition.
- Unmet goal evaluation dispatches at most one continuation turn per completed
  provider turn.
- Focused regression coverage exercises parser, orchestration state, evaluator
  prompt/schema, and goal continuation behavior.

### Status

- Completed.

### Verification

- Passed: `bun run test src/composer-logic.test.ts` in `apps/web`.
- Passed: `bun run test src/textGeneration/TextGenerationPrompts.test.ts src/textGeneration/TextGeneration.test.ts src/orchestration/Layers/OrchestrationReactor.test.ts` in `apps/server`.
- Passed: `bun fmt`.
- Passed: `bun lint` with warnings only.
- Passed: `bun typecheck`.

### Open Questions / Proposed Changes

- None.

## Current Task: Retire Stale Mobile Track Sync Workflow

Stop the daily GitHub Actions failure caused by the obsolete mobile-track sync
workflow fetching an upstream branch that no longer exists.

### Current User Requirements

- Recommend the safest response to the failing `Mobile Track Sync` scheduled build.
- Continue with clear next steps when the correct path is unambiguous.
- Stop the recurring failure emails from the stale scheduled workflow.

### Constraints

- Do not retarget mobile automation to an unrelated upstream branch.
- Preserve the main desktop/headless nightly release pipeline.
- Follow repo instructions: use `bun run test`, never `bun test`; all of
  `bun fmt`, `bun lint`, and `bun typecheck` must pass before completion when
  code changes require them.

### Acceptance Criteria

- The stale scheduled `Mobile Track Sync` workflow can no longer fail daily due
  to missing `t3code/mobile-remote-connect`.
- Fork release documentation no longer describes the retired workflow as active.
- The change is limited to workflow/docs metadata and does not affect release
  builds.

### Status

- Completed.

### Verification

- Passed: `git diff --check`.
- Passed: `bun fmt`.
- Passed: `bun lint` with existing warnings only.
- Passed: `bun typecheck`.

### Open Questions / Proposed Changes

- None.

## Current Task: Integrate UI Stability and Synchronization Fixes from Forks

Integrate the recommended UI stability, Zustand store reactivity, terminal exit, and server-side transient event synchronization fixes from active upstream forks.

### Current User Requirements

- Integrate backend-frontend event synchronization and stream performance fixes (from `upstream/cursor/event-persistence-synchronization-2379`).
- Integrate Zustand store reactivity and infinite render loop fixes (from `upstream/cursor/store-reactivity-and-updates-d19b`).
- Integrate chat auto-scroll stability fixes (from `upstream/cursor/chat-view-auto-scroll-bug-cbbd`).
- Integrate terminal exit graceful handling fixes (from `upstream/cursor/terminal-exit-error-handling-eafe`).
- Integrate terminal drawer resize optimizations (from `upstream/cursor/react-component-health-4a54`).
- Integrate background non-blocking provider check optimizations (from `upstream/cursor/react-component-health-20cc` via `prisco-ai/main`).
- Integrate polished chat markdown heading and checklist rendering styles (from `prisco-ai/main`).
- Ensure all integrated changes are clean, functional, and fully verified.

### Constraints

- Follow repo checks: `bun fmt`, `bun lint`, and `bun typecheck` must pass before completion.
- Do not run `bun test`; use Vitest package test scripts via `bun run test` or direct test execution.
- Scope the changes strictly to the relevant branches and files.

### Acceptance Criteria

- All five target branches are successfully merged or cherry-picked.
- The server build, web build, and test suites run successfully without errors or type regressions.
- `bun fmt`, `bun lint`, and `bun typecheck` pass cleanly.

### Status

- Completed.

### Verification

- Passed: server-side integration tests in `apps/server` (all 86 tests passed green, including the new background refresh test and the updated settings re-probe test).
- Passed: `bunx tsc --noEmit` in both `apps/web` and `apps/server` (zero TypeScript errors).
- Passed: `bunx oxfmt` (formatted cleanly).
- Passed: `bun run lint` (zero errors, only pre-existing warnings in web).

### Open Questions / Proposed Changes

- None.

## Current Task: Stop Archived Threads From Leaving Stale Provider Instances

Implement the approved plan to prevent archived T3 threads from leaving stale
provider sessions and `opencode serve` processes behind.

### Current User Requirements

- Archiving a thread must reliably stop its provider session regardless of
  whether the archive command comes from the web UI, `t3-thread`, or a direct
  orchestration RPC client.
- Archived threads must not keep OpenCode, Claude, Codex, terminal, or provider
  runtime state alive.
- Existing archived-but-running provider runtime rows must self-heal without
  manual SQL cleanup.
- Preserve archived thread content/history; archive is not deletion.
- Move archive cleanup into the server orchestration lifecycle rather than
  relying on transport-specific WebSocket post-processing.
- Make `thread.session.stop` work for archived, non-deleted threads.
- Add an archived-session reaper backstop.
- Add OpenCode process observability sufficient to map server process PID/port
  to T3 thread context.

### Constraints

- No external wire protocol change.
- No database migration.
- No `t3-thread` CLI change required for correctness.
- Archive means provider-runtime retirement, even when the archived thread has
  an active turn.
- Archive closes terminals without deleting terminal history.
- Follow repo instructions: use `bun run test`, never `bun test`; all of
  `bun fmt`, `bun lint`, and `bun typecheck` must pass before completion.

### Acceptance Criteria

- Archived threads cannot remain `provider_session_runtime.status = 'running'`
  because of archive ordering.
- UI archive, `t3-thread archive`, and direct
  `orchestration.dispatchCommand(thread.archive)` share the same cleanup
  behavior.
- Existing stale archived sessions are stopped by the provider session reaper
  on the first relevant sweep.
- Cleanup failures do not fail archive, and logs contain enough detail to
  diagnose failed provider stop or terminal close.
- Focused tests cover archived-inclusive lookup, session stop after archive,
  archive cleanup reactor behavior, reaper behavior, and WebSocket archive
  behavior after removing transport-specific cleanup.

### Status

- Complete.

### Verification

- `PATH=/Users/brad/.nvm/versions/node/v22.22.1/bin:$PATH bun run --shell system test src/orchestration/Layers/ProviderCommandReactor.test.ts src/orchestration/Layers/ProjectionSnapshotQuery.test.ts src/provider/Layers/ProviderSessionReaper.test.ts src/server.test.ts src/orchestration/Layers/ThreadArchiveCleanupReactor.test.ts src/orchestration/Layers/OrchestrationReactor.test.ts` from `apps/server`: passed, 6 files / 121 tests.
- `bun fmt`: passed.
- `bun lint`: passed with 9 existing unrelated warnings in `apps/web`.
- `bun typecheck`: passed.

### Open Questions / Proposed Changes

- None.

## Current Task: T3 Thread Cleanup and Deployment Verification

Clean up completed/stale T3 Code threads for this repo after confirming their
work is committed and merged, fast-forward local `main`, and verify the current
fork deployment/release path is working as expected.

### Current User Requirements

- Fast-forward local `main` after confirming other T3 thread work is already
  committed and merged.
- Clean up completed/stale T3 Code threads and their local worktrees/branches.
- Do not drop or delete any uncommitted or unmerged thread work.
- Make sure deployment is working as expected.

### Constraints

- Use supported cleanup paths: archive remote T3 threads first, then remove
  local mappings/worktrees/branches as applicable.
- Do not clean up the current conversation thread before the final response.
- Keep the active Mac nightly/release thread until the release/deployment lane
  is verified or there is a clear blocker.
- Follow repo instructions: `bun fmt`, `bun lint`, and `bun typecheck` are the
  completion checks for code changes; do not run `bun test`.

### Acceptance Criteria

- Local `main` is up to date with `origin/main`.
- Checked T3 worktrees have no uncommitted files and no commits ahead of
  `origin/main` before removal.
- Stale/completed repo threads are archived or otherwise accounted for.
- Removed local T3 worktrees/branches no longer appear in `git worktree list`
  or local branch listings.
- GitHub release/deployment status is checked for macOS desktop, Linux
  headless, and mobile lanes, with any remaining blocker called out.

### Status

- Completed.

### Verification

- Passed: local `main` fast-forwarded to `origin/main` at
  `05e0b571935f8ab7228fb65842f5fbfb0e4ec250`.
- Passed: checked five stale T3 worktrees/branches before cleanup; each was
  clean and had `0` commits ahead of `origin/main`.
- Passed: archived/forgot stale T3 threads for this repo and left only the
  current conversation thread active.
- Passed: removed the stale local T3 worktrees and local `t3code/*` cleanup
  branches; `git worktree list --porcelain` now shows only the main checkout.
- Passed: release workflow rerun
  `https://github.com/jimprince/t3code/actions/runs/26557738388` completed
  successfully for head SHA `05e0b571935f8ab7228fb65842f5fbfb0e4ec250`.
- Passed: release `v0.0.25-nightly.20260515.295-fork.10` was published as a
  prerelease with macOS arm64 DMG/ZIP, blockmaps, `nightly-mac.yml`, and Linux
  headless tarball assets.
- Passed: `nightly-mac.yml` downloads successfully and advertises version
  `0.0.25-nightly.20260515.295-fork.10` with macOS arm64 ZIP and DMG entries.
- Passed: mobile lane latest checked run,
  `Mobile Track EAS Update` run `26181606004`, completed successfully on
  `2026-05-20`.

### Open Questions / Proposed Changes

- None.

### User-Approved Requirement Changes

- None.

## Active Requirements

- Double-check the proposed OpenCode stale "Working" shell-stream fix before
  applying it.
- Do not apply a fix that only masks stale UI state if the persisted
  provider/session projection is still stale.
- If the proposed fix is incomplete, implement the smaller root-cause fix that
  clears completed OpenCode-backed threads from `Working` reliably.
- Fix OpenCode-backed threads so completed threads do not continue to display
  as "Working" in the sidebar or conversation footer after the agent has
  finished responding.
- Commit, merge, and push the OpenCode stale-working fix.
- Use the local Mac as an on-demand GitHub Actions build worker for T3 Code
  macOS arm64 builds to reduce remote build latency.
- Keep Linux/headless builds on GitHub-hosted runners unless explicitly changed.
- Route only trusted T3 Code release/fork build jobs to the self-hosted Mac
  runner label.
- Do not install the local runner as a permanent startup/login service unless
  explicitly requested.
- Ensure CI/release dependency setup installs the Electron binary before desktop
  tests or desktop artifact builds import Electron.
- Troubleshoot why a new thread cannot be created in a project just created from a local folder.
- Account for the case where the project had no git repo initially and Git was initialized from the UI afterward.
- Implement a fix if the failure is in the repo.
- Commit the fix and push it to GitHub.
- Follow the GitHub macOS build after pushing.
- Explain current GitHub push behavior for release vs nightly builds.
- Change push-triggered fork builds so normal pushes publish to the nightly
  channel instead of creating updater-visible stable fork-interim releases.
- Preserve integration into the next stable release through the existing
  upstream stable sync/rebase path.

## Current Task: Fix OpenCode Thread Continuity After Idle Resume

Diagnose and fix the continuity loss reported for thread
`194f1cc3-0954-4d7d-be51-f5bc0fabe4a1`, where a follow-up message after an
idle gap behaved as if the thread had no prior context.

### Current User Requirements

- Inspect the persisted messaging history and provider runtime state for the
  specific failing thread.
- Troubleshoot why follow-up messages after stepping away lose continuity.
- Implement the fix rather than only reporting a plan.
- Preserve predictable session recovery under provider process restart/reap.

### Acceptance Criteria

- The root cause is identified from persisted history/logs.
- OpenCode-backed threads persist enough provider resume state to recover the
  same provider session after idle/reconnect/restart.
- Regression coverage proves recovery starts OpenCode from the saved session id
  instead of creating a blank session.
- Repo-required verification is run or blockers are explicitly recorded.

### Status

- Completed.

### Verification

- Confirmed from the live `state.sqlite` and provider log that
  `194f1cc3-0954-4d7d-be51-f5bc0fabe4a1` is an OpenCode thread whose
  `provider_session_runtime.resume_cursor_json` is `null`; the follow-up turn
  ran in a different OpenCode session id than the prior deployment turn.
- Passed: added OpenCode adapter regression coverage proving an explicit
  `{ sessionId }` resume cursor is used for `session.get`, then for the next
  `session.promptAsync`, without creating a blank session.
- Passed: added fallback coverage proving older uncursored T3 threads reuse the
  exact-title OpenCode session with the earliest creation time instead of
  creating another duplicate session.
- Passed: `bun --filter t3 test -- src/provider/Layers/OpenCodeAdapter.test.ts`.
- Passed: `bun fmt`.
- Passed: `bun lint` with 9 existing warnings and 0 errors.
- Passed: `bun typecheck`.

## Current Task: Fix OXLint Plugin Loading

Make `bun lint` work again by addressing the existing failure where oxlint
loads `./oxlint-plugin-t3code/index.ts` directly and Node rejects the `.ts`
extension.

### Current User Requirements

- Address the `bun lint` blocker from `ERR_UNKNOWN_FILE_EXTENSION` on the local
  oxlint TypeScript plugin.
- Preserve the custom `t3code/no-inline-schema-compile` lint rule.
- Keep the fix compatible with normal repo scripts and CI-style invocation.

### Acceptance Criteria

- `bun lint` builds or loads the custom oxlint plugin successfully.
- The custom rule remains enabled through `.oxlintrc.json`.
- Existing targeted verification for the sandboxed conflict workflow still
  passes after the lint fix.

### Status

- Completed.

### Verification

- Passed: added `oxlint-plugin-t3code/tsconfig.build.json` and a package
  `build` script that emits the TypeScript oxlint plugin to `dist/`.
- Passed: updated `.oxlintrc.json` to load
  `./oxlint-plugin-t3code/dist/index.js` instead of the TypeScript source.
- Passed: updated root `bun lint` to build the custom plugin before invoking
  oxlint, preserving `t3code/no-inline-schema-compile`.
- Passed: `bun --filter @t3tools/oxlint-plugin-t3code build`.
- Passed: `bun --filter @t3tools/oxlint-plugin-t3code typecheck`.
- Passed: `bun --filter @t3tools/oxlint-plugin-t3code test`.
- Passed: `bun lint` now exits 0; it reports 9 existing warnings and 0 errors.
- Passed: `bun typecheck`.
- Passed: `bun --filter @t3tools/scripts test mobile-conflict-controller.test.ts`.

## Current Task: Sandboxed Automatic Conflict PRs

Implement the sandboxed conflict-resolution plan for mobile-track sync:
clean rebases remain fully automatic, but conflicted upstream rebases must not
run in a normal trusted T3 worker. Instead, GitHub dispatches conflict metadata
to a dev-VM controller, which launches an isolated Docker resolver and produces
a candidate PR for manual phone review.

### Current User Requirements

- Keep `mobile-track-sync.yml` fully automatic for clean rebases: rebase,
  verify, push `feature/mobile-track`, and publish EAS only when clean.
- On rebase conflict, do not push `feature/mobile-track` and do not publish EAS.
- On rebase conflict, send a GitHub `repository_dispatch` event to a dev-VM
  controller containing only metadata: upstream SHA, mobile SHA, sync run id,
  conflicted files, and branch names.
- Add a dev-VM controller service that validates HMAC/signature and repo
  allowlist, queues one mobile conflict job at a time, uses a temporary resolver
  workspace, and starts a locked-down Docker container.
- Resolver guardrails: non-root container user; no bind mounts of `/home/brad`,
  `.ssh`, `.config`, Docker socket, T3 state, EAS credentials, or shared service
  volumes; fresh clone of only `jimprince/t3code`; no EAS token; cannot update
  `feature/mobile-track`; cannot publish EAS.
- Candidate output goes to
  `automation/mobile-track-conflict/<sync-run-id>` and opens a PR against
  `feature/mobile-track` with upstream SHA, original mobile SHA, conflicted
  files, resolver log summary, and check results.
- Promotion remains manual: review/approve from phone, then merge or run a
  manual promote workflow; only promotion to `feature/mobile-track` can trigger
  or dispatch EAS.
- Treat repo contents, upstream changes, conflict markers, docs, comments, and
  commit messages as untrusted input for the AI resolver.

### Acceptance Criteria

- Clean upstream rebase path still directly verifies, pushes, and can publish
  EAS.
- Conflict path dispatches metadata for sandboxed handling while preventing EAS
  publish and mobile-branch push.
- Dev-VM controller and resolver scripts are documented and testable locally.
- Resolver container cannot access trusted host paths, long-lived credentials,
  Docker socket, T3 state, or EAS token through configured mounts/env.
- Candidate PR branch and body include the required audit metadata.
- Stale candidates cannot be promoted if `feature/mobile-track` moved.

### Status

- Completed.

### Verification

- Passed: `mobile-track-sync.yml` now preserves the clean rebase path and
  gates all verification, push, and EAS steps behind a non-conflict rebase.
- Passed: conflict path records conflicted files, aborts the rebase, dispatches
  `mobile-track-conflict` metadata, and then fails before mobile-branch push or
  EAS publish.
- Passed: added `scripts/mobile-conflict-controller.ts` with HMAC validation,
  repository allowlist validation, single-job queueing, temporary workspaces,
  and locked-down Docker invocation construction.
- Passed: added non-root resolver container files and a resolver script that
  fresh-clones `jimprince/t3code`, refuses stale input SHAs, pushes only
  `automation/mobile-track-conflict/<sync-run-id>`, and opens/updates a PR.
- Passed: added manual `mobile-track-conflict-promote.yml` that rejects stale
  candidates if `feature/mobile-track` moved before promotion.
- Passed: temporarily added a forbidden `/home/brad` bind mount and confirmed
  `mobile-conflict-controller.test.ts` failed on the guardrail assertion, then
  restored the locked-down Docker args and confirmed the test passed.
- Passed: `bun --filter @t3tools/scripts test mobile-conflict-controller.test.ts`.
- Passed: `bun --filter @t3tools/scripts typecheck`.
- Passed: `bun typecheck`.
- Passed: `bun fmt`.
- Passed: `go run github.com/rhysd/actionlint/cmd/actionlint@latest .github/workflows/mobile-track-sync.yml .github/workflows/mobile-track-conflict-promote.yml`.
- Passed: `bash -n scripts/mobile-conflict-resolver.sh`.
- Passed: remote dev VM Docker build from a minimal `/tmp` context:
  `docker build -f ops/mobile-conflict-resolver/Dockerfile -t t3code-mobile-conflict-resolver:test .`.
- Passed: remote container smoke check confirmed UID/GID `10001:10001` and
  `git`, `jq`, `gh`, and `bun` are executable for the non-root resolver user.
- Resolved in the follow-up OXLint task above: `bun lint` now builds and loads
  the custom plugin successfully.

## Current Task: Export T3 Environment Metadata To Agent Runtime

Extend the T3 launcher child-process environment so coding agents can discover
the current T3 environment directly from environment variables instead of
scanning saved environments or depending on a non-expired pairing.

### Current User Requirements

- Continue exporting `T3_THREAD_ID=<thread-id>`.
- Also export `T3_ENVIRONMENT_NAME=<environment-name>` for the environment the
  current thread belongs to, for example `local-mbp`.
- Also export `T3_ENVIRONMENT_ID=<environment-id>` for the environment the
  current thread belongs to, for example
  `5fa7c701-bf4d-496f-b753-55f77b4de905`.
- Make this useful for `t3-thread` callers to resolve a current thread payload
  like `{ "threadId": "...", "environment": "local-mbp", "saved": false }`
  without scanning saved environments or relying on a live pairing.

### Acceptance Criteria

- Spawned Codex app-server child env includes `T3_THREAD_ID`,
  `T3_ENVIRONMENT_ID`, and `T3_ENVIRONMENT_NAME` when the server can identify
  the current environment.
- Existing `CODEX_HOME` and base environment preservation behavior remains
  intact.
- Regression coverage proves environment metadata injection and optional
  behavior when metadata is absent.
- The relevant caller/resolver surface is updated if it exists in this repo.
- Repo-required verification is run or any blockers are reported.

### Status

- Implemented and verified with `bun fmt`, `bun lint`, focused provider tests,
  and `bun typecheck`.

## Current Task: Restore Codex T3_THREAD_ID Env Injection

Restore the fork patch that injects the T3 orchestration thread id into spawned
Codex app-server processes, push it to GitHub, and monitor the rebuild.

### Current User Requirements

- Add `T3_THREAD_ID` env injection back to the current build path.
- Check whether any other commits that were supposed to be rebased onto
  `pingdotgg/t3code` fell out and should likely be kept.
- Push the restored patch to GitHub.
- Monitor the resulting rebuild.

### Acceptance Criteria

- Spawned Codex app-server child env includes `T3_THREAD_ID` equal to the
  server-side thread id.
- Existing `CODEX_HOME` behavior is preserved.
- Regression coverage proves both `T3_THREAD_ID` and optional `CODEX_HOME`
  handling.
- The audit identifies likely lost fork patches or explains why no other
  obvious keepers were found.
- The fix is pushed to `jimprince/t3code`.
- The relevant GitHub Actions rebuild is monitored and reported.

### Status

- Completed.

### Verification

- Passed: confirmed the active shell/session did not have `T3_THREAD_ID` in
  its environment before the fix.
- Passed: found the prior fork patch in historical commits and confirmed the
  current rebased build path had dropped the Codex child-process
  `T3_THREAD_ID` injection.
- Passed: restored `T3_THREAD_ID` injection for spawned Codex app-server
  processes while preserving caller environment and `CODEX_HOME` behavior.
- Passed: added regression coverage for `T3_THREAD_ID` with and without
  `CODEX_HOME`.
- Passed: focused Codex session runtime test passed.
- Passed: `bun fmt`.
- Passed: `bun lint` with pre-existing warnings only.
- Passed: `bun typecheck`.
- Passed: pushed stable fix and release prep to `jimprince/t3code`.
- Passed: GitHub Actions release run `26180240306` completed successfully for
  `v0.0.25-fork.1`.
- Passed: stable release assets include `latest-mac.yml`, macOS arm64 DMG/zip
  assets and blockmaps, `builder-debug.yml`, and the Linux x64 headless
  tarball.
- Passed: rebased the fork onto upstream
  `v0.0.25-nightly.20260515.295`, stamped
  `0.0.25-nightly.20260515.295-fork.1`, and pushed `main` plus tag
  `v0.0.25-nightly.20260515.295-fork.1`.
- Passed: patched scheduled sync/release workflows to avoid the broken
  `GH_PAT` checkout/API path and explicitly dispatch release publishing after
  token-authenticated sync pushes.
- Passed: local `actionlint` for `sync-upstream.yml`,
  `fork-interim-release.yml`, and `release.yml`.
- Passed: GitHub Actions release run `26181112859` completed successfully for
  `v0.0.25-nightly.20260515.295-fork.1`.
- Passed: main CI run `26181112838` completed successfully for
  `79ed044ee629967e6590deee50d2074a8c24739c`.
- Passed: nightly release is a prerelease and contains `nightly-mac.yml`,
  macOS arm64 DMG/zip assets and blockmaps, `builder-debug.yml`, and the Linux
  x64 headless tarball.
- Passed: `nightly-mac.yml` reports version
  `0.0.25-nightly.20260515.295-fork.1` and points to the matching arm64 zip
  and DMG assets.

## Current Task: Resolve Nightly 285 Upstream Sync Rebase

Repair the scheduled `Sync Upstream` failure for the nightly channel by
rebasing the fork onto upstream `v0.0.24-nightly.20260514.285`, resolving the
known fork/upstream conflicts intentionally, and publishing the corresponding
fork nightly build.

### Current User Requirements

- Resolve the current GitHub `Sync Upstream` nightly failure.
- Preserve the fork release model while reconciling upstream changes.
- Keep Linux releases headless-only; do not restore Linux Electron/AppImage.
- Keep the minimal fork build matrix: macOS arm64 Electron and Linux x64
  headless server artifact.
- Push the repaired history/tag so GitHub can produce the new nightly build.
- Verify the resulting GitHub release assets and updater manifest.

### Acceptance Criteria

- Fork `main` rebases cleanly onto upstream
  `v0.0.24-nightly.20260514.285`.
- Browser-resume reconnect conflict is resolved against upstream's newer
  implementation without reintroducing unnecessary reconnects.
- Headless artifact and headless update-check fork patches remain present.
- `origin/main` is updated with a safe `--force-with-lease` push.
- A new fork nightly tag for upstream `.285` is pushed.
- GitHub Actions release run completes for the new nightly tag.
- Release verification confirms prerelease status, macOS updater manifest, mac
  artifacts, and Linux/headless artifact.

### Status

- Completed.

### Verification

- Passed: latest failing `Sync Upstream` run `25881898332` was a nightly
  rebase conflict against upstream `v0.0.24-nightly.20260514.285`.
- Passed: rebased fork stack onto upstream
  `v0.0.24-nightly.20260514.285`.
- Passed: resolved browser-resume reconnect conflicts by keeping upstream's
  newer service/test implementation.
- Passed: resolved headless artifact conflict by keeping shared
  `scripts/lib/client-assets.ts` validation and upstream's newer desktop
  runtime dependency filtering.
- Passed: resolved RPC contract conflict by keeping both upstream process
  resource history RPCs and fork headless update-check RPCs.
- Passed: removed a duplicate `isHeartbeatFresh` merge artifact from
  `apps/web/src/rpc/wsRpcClient.ts`.
- Passed: stamped package versions to
  `0.0.24-nightly.20260514.285-fork.1`.
- Passed: `go run github.com/rhysd/actionlint/cmd/actionlint@latest
.github/workflows/sync-upstream.yml .github/workflows/release.yml`.
- Passed: `bun fmt`.
- Passed: `NODE_BIN_DIR=$(dirname "$(bunx node@24 -e
'console.log(process.execPath)')"); PATH="$NODE_BIN_DIR:$PATH" bun lint`
  with pre-existing warnings only.
- Passed: `NODE_BIN_DIR=$(dirname "$(bunx node@24 -e
'console.log(process.execPath)')"); PATH="$NODE_BIN_DIR:$PATH" bun
typecheck`.
- Passed: focused web tests: `bun run test
src/environments/runtime/service.threadSubscriptions.test.ts
src/serverUpdateCheck.test.ts` from `apps/web`.
- Passed: focused artifact tests: `bun run test
build-headless-artifact.test.ts build-desktop-artifact.test.ts` from
  `scripts`.
- Passed: focused server update-check test: `bun run test
src/headlessUpdateCheck.test.ts` from `apps/server`.
- Passed: force-pushed repaired `main` to
  `2868d38451714d5acbae75ed6c05bb22a19ce9a3`.
- Passed: pushed tag `v0.0.24-nightly.20260514.285-fork.1` at
  `2868d38451714d5acbae75ed6c05bb22a19ce9a3`.
- Passed: GitHub Actions release run `25884383186` completed successfully:
  preflight, macOS arm64 build, Linux/headless build and smoke test, and
  release publish all passed.
- Passed: release `v0.0.24-nightly.20260514.285-fork.1` is a prerelease.
- Passed: release assets include `nightly-mac.yml`, macOS arm64 DMG/zip and
  blockmaps, `builder-debug.yml`, and
  `t3-headless-0.0.24-nightly.20260514.285-fork.1-linux-x64.tar.gz`.
- Passed: `nightly-mac.yml` reports version
  `0.0.24-nightly.20260514.285-fork.1` and points to the matching arm64 zip
  and DMG assets.
- Passed: manual `Sync Upstream` run `25885042722` completed successfully for
  the nightly channel and skipped rebase because the fork tag already exists.

## Current Task: Resolve Nightly 277 Upstream Sync Rebase

Repair the scheduled `Sync Upstream` failure for the nightly channel by
rebasing the fork onto upstream `v0.0.24-nightly.20260513.277`, resolving the
release workflow conflict intentionally, and publishing the corresponding fork
nightly build.

### Current User Requirements

- Resolve the most recent GitHub `Sync Upstream` nightly failure.
- Preserve the fork release model while reconciling upstream changes.
- Keep Linux releases headless-only; do not restore Linux Electron/AppImage.
- Keep the minimal fork build matrix: macOS arm64 Electron and Linux x64
  headless server artifact.
- Push the repaired history/tag so GitHub can produce the new nightly build.
- Verify the resulting GitHub release assets and updater manifest.

### Acceptance Criteria

- Fork `main` rebases cleanly onto upstream
  `v0.0.24-nightly.20260513.277`.
- `.github/workflows/release.yml` keeps fork nightly tag semantics, macOS
  arm64 Electron publishing, Linux x64 headless publishing, and release asset
  validation.
- `origin/main` is updated with a safe `--force-with-lease` push.
- A new fork nightly tag for upstream `.277` is pushed.
- GitHub Actions release run completes for the new nightly tag.
- Release verification confirms prerelease status, macOS updater manifest, mac
  artifacts, and Linux/headless artifact.

### Status

- Completed.

### Verification

- Passed: rebased fork stack onto upstream
  `v0.0.24-nightly.20260513.277`.
- Passed: resolved `.github/workflows/release.yml` by preserving the fork
  release workflow: tag-driven releases, fork nightly tags, macOS arm64
  Electron artifact, Linux x64 headless artifact, and release asset validation.
- Passed: stamped package versions to
  `0.0.24-nightly.20260513.277-fork.1`.
- Passed: `ruby -e 'require "yaml"; YAML.load_file(...)'` for
  `release.yml` and `sync-upstream.yml`.
- Passed: `go run github.com/rhysd/actionlint/cmd/actionlint@latest
.github/workflows/release.yml .github/workflows/sync-upstream.yml`.
- Passed: `bun fmt`.
- Passed: `NODE_BIN_DIR=$(dirname "$(bunx node@24 -e
'console.log(process.execPath)')"); PATH="$NODE_BIN_DIR:$PATH" bun lint`
  with pre-existing warnings only.
- Passed: `NODE_BIN_DIR=$(dirname "$(bunx node@24 -e
'console.log(process.execPath)')"); PATH="$NODE_BIN_DIR:$PATH" bun
typecheck`.
- Partial: full `bun run test` initially failed because Electron was missing
  after an `--ignore-scripts` install; after running Electron's install script,
  desktop tests passed and only one web test timed out.
- Passed: focused retry
  `bun --filter @t3tools/web test
src/environments/runtime/service.addSavedEnvironment.test.ts`.
- Passed: force-pushed repaired `main` to `43bba1001148db8a0614438aca45cae56a835d39`.
- Passed: pushed tag `v0.0.24-nightly.20260513.277-fork.1` at
  `43bba1001148db8a0614438aca45cae56a835d39`.
- Passed: GitHub Actions release run `25834014502` completed successfully:
  preflight, macOS arm64 build, Linux/headless build and smoke test, and
  release publish all passed.
- Passed: release `v0.0.24-nightly.20260513.277-fork.1` is a prerelease and
  `v0.0.24-fork.1` remains the latest stable release.
- Passed: release assets include `nightly-mac.yml`, macOS arm64 DMG/zip and
  blockmaps, `builder-debug.yml`, and
  `t3-headless-0.0.24-nightly.20260513.277-fork.1-linux-x64.tar.gz`.
- Passed: `nightly-mac.yml` reports version
  `0.0.24-nightly.20260513.277-fork.1` and points to the matching arm64 zip
  and DMG assets.
- Follow-up: main CI run `25834009325` failed only at `bun run fmt:check`
  because this tracker entry needed formatting; a docs-only formatting repair
  is being pushed after this update.

## Current Task: Repair Nightly Release Channel

Fix the nightly release state so the nightly channel has a current build that
includes the latest fork fixes, and verify the nightly artifacts/updater
manifest do not have obvious release-channel issues.

### Current User Requirements

- Fix the nightlies.
- Make sure there are no issues with the nightly release/build artifacts.
- Preserve the fork release model and avoid accidental stable/latest changes.

### Acceptance Criteria

- A new nightly fork release is published from the current fixed code.
- The nightly release is marked as a prerelease, not the latest stable release.
- macOS arm64 artifacts and nightly updater manifest are present.
- Linux/headless artifact is present.
- GitHub Actions release run completes successfully.
- Any workflow/release issues found during investigation are fixed or reported.

### Status

- Completed.

### Verification

- Passed: latest upstream nightly is `v0.0.24-nightly.20260511.260`; fork
  already had `-fork.4`, so a reroll was needed to include current fork fixes.
- Passed: created stamped tag commit
  `9483ce253e211f462a03705c66473614c6798f44` for
  `v0.0.24-nightly.20260511.260-fork.5`.
- Passed: GitHub Actions release run `25760182337` completed successfully:
  preflight, macOS arm64 build, Linux/headless build, and publish all passed.
- Passed: release `v0.0.24-nightly.20260511.260-fork.5` is a prerelease and
  `v0.0.24-fork.1` remains the latest stable release.
- Passed: nightly release contains `nightly-mac.yml`, macOS arm64 DMG/zip and
  blockmaps, and `t3-headless-0.0.24-nightly.20260511.260-fork.5-linux-x64.tar.gz`.
- Passed: `nightly-mac.yml` reports version
  `0.0.24-nightly.20260511.260-fork.5` and points at the matching arm64 zip
  and dmg assets.

## Current Task: Release Archive Idempotency Fix

Commit and push the thread archive idempotency fix, ensure GitHub publishes a
new build, then update the local macOS app and the remote headless server.

### Current User Requirements

- Commit the completed archive idempotency fix.
- Push it to GitHub.
- Make sure the change deploys through the fork release/build pipeline.
- Update the local T3 Code app.
- Update the remote `brad-linux-dev` headless T3 Code server.

### Acceptance Criteria

- The fix is present on the pushed branch used for the fork release.
- GitHub release/build status is checked and reported.
- A new macOS build is installed or the local updater is confirmed current on
  the new build.
- A new Linux/headless build is installed on `brad-linux-dev`.
- Remote health reports the new server version after upgrade.

### Status

- Completed.

### Verification

- Passed: pushed fix commit `1e7f5d7babe9f7b2045af010a2106abf1b0d4c85` to
  `origin/main`.
- Passed: GitHub Actions release run `25758403268` completed successfully for
  tag `v0.0.24-fork.1`.
- Passed: GitHub release `v0.0.24-fork.1` published macOS arm64 and Linux
  headless artifacts.
- Passed: local `/Applications/T3 Code (Fork).app` reports version
  `0.0.24-fork.1`.
- Passed: remote `brad-linux-dev` reports server version `0.0.24-fork.1` from
  `/.well-known/t3/environment`.

## Current Task: Make Thread Archive Idempotent

Make repeated archive commands succeed as no-ops when the target thread is
already archived, so users do not see a failure after archive already
succeeded.

### Current User Requirements

- Implement the approved plan for fixing the archive error.
- Prefer server-side semantic idempotency for `thread.archive`.
- Preserve normal failure behavior for invalid archive requests, such as a
  missing thread.
- Add regression coverage and run the repo-required verification.

### Acceptance Criteria

- Archiving an active thread emits exactly one `thread.archived` event.
- Archiving an already archived thread succeeds without emitting a duplicate
  archive event.
- Replaying/retrying archive after a persisted archive event no longer reports
  `already archived`.
- Missing-thread archive commands still fail.
- No public WebSocket/schema/client API changes are required.

### Status

- Completed.

### Verification

- Passed: focused regression test first failed against the old behavior with
  `already archived`.
- Passed: temporarily disabled the no-op branch and confirmed the idempotency
  regression test failed with a duplicate archive sequence.
- Passed: `NODE_BIN_DIR=$(dirname "$(bunx node@24 -e 'console.log(process.execPath)')"); PATH="$NODE_BIN_DIR:$PATH" bun run --filter t3 test src/orchestration/Layers/OrchestrationEngine.test.ts`.
- Passed: `NODE_BIN_DIR=$(dirname "$(bunx node@24 -e 'console.log(process.execPath)')"); PATH="$NODE_BIN_DIR:$PATH" bun run --filter t3 test`.
- Passed: `bun fmt`.
- Passed: `bun lint` with pre-existing warnings only.
- Passed: `bun typecheck` with pre-existing Effect language-service messages
  only.

## Current Task: Schedule Clean Mobile Track Sync

Add default-branch automation that periodically checks whether the fork mobile
track is behind upstream and automatically updates it only when the rebase is
clean.

### Current User Requirements

- Run this kind of upstream/build status check on GitHub schedule.
- If `feature/mobile-track` is out of date and there is nothing to review,
  automatically rebase/update it.
- If upstream changes supersede or conflict with fork changes, do not guess;
  surface the conflict for manual review.
- Preserve the documented three-lane remote build status model: mac Electron,
  Linux/headless, and mobile.

### Acceptance Criteria

- The scheduled workflow lives on default branch `main`, because GitHub
  schedules only run default-branch workflow files.
- The workflow checks `feature/mobile-track` against
  `upstream/t3code/mobile-remote-connect`.
- A clean rebase runs verification, pushes with `--force-with-lease`, and
  publishes an EAS update.
- Conflicts fail without pushing partial state and report conflicted files.
- Repo instructions document the scheduled clean-rebase behavior.

### Status

- Completed: added `.github/workflows/mobile-track-sync.yml` on `main`.
- Completed: documented the scheduled clean-rebase behavior in
  `LLM_INSTRUCTIONS.md` and `docs/release.md`.
- Completed: validation run:
  - YAML parsed successfully with Ruby `YAML.load_file`.
  - `bun fmt`
  - `go run github.com/rhysd/actionlint/cmd/actionlint@latest .github/workflows/mobile-track-sync.yml`
  - `bun install --frozen-lockfile`
  - `bun typecheck`
- Blocked: `bun lint` fails on clean `origin/main` before reaching this change
  because oxlint `1.63.0` cannot load the existing TypeScript JS plugin
  `./oxlint-plugin-t3code/index.ts` (`ERR_UNKNOWN_FILE_EXTENSION`). The same
  workflow lint path runs against `feature/mobile-track`, where lint has passed
  after install.
- In progress: completing the clean `origin/main` branch commit for review.

## Current Task: Recover Main Upstream Sync And Release Builds

Repair the fork `main` sync after scheduled `Sync Upstream` runs failed while
rebasing the fork stack onto current upstream stable/nightly releases.

### Current User Requirements

- Resolve the failed fork rebase as recommended, using a fresh worktree.
- Prefer as few fork changes as possible relative to upstream.
- Preserve fork functionality only where it still provides the reason the fork
  change was added.
- If an upstream change appears to supersede a fork change, check with Brad
  before keeping the fork change.
- If in doubt, stop and review the fork-vs-upstream choice with Brad.
- Restore the remote build path and verify all three lanes: mac Electron,
  Linux/headless, and mobile.

### Acceptance Criteria

- The fork stack rebases cleanly onto the latest relevant upstream stable and
  nightly tags.
- Manual conflict resolutions preserve fork behavior only where still needed.
- `origin/main` is repaired through a safe force-with-lease push.
- Release tags are pushed for the repaired upstream stable/nightly targets as
  appropriate.
- GitHub Actions release/update results are checked for mac Electron,
  Linux/headless, and mobile lanes.
- Required local checks pass before pushing, or blockers are reported.

### Status

- Stable recovery completed and pushed: rebased the fork stack onto upstream
  `v0.0.23`, stamped `0.0.23`, pushed `origin/main` with
  `--force-with-lease`, and pushed tag `v0.0.23`.
- Nightly rebase completed locally onto upstream
  `v0.0.24-nightly.20260511.260`; pending final fork version stamp,
  validation, push, tag, and GitHub Actions verification.
- Conflict decisions so far:
  - Kept the fork release workflow instead of upstream hosted-web/Discord
    release jobs because this fork publishes GitHub desktop/headless artifacts.
  - Kept fork release documentation where it describes fork-only
    desktop/headless artifacts and updater behavior.
  - Kept upstream hosted-channel branding logic and limited the fork delta to
    the non-hosted production fallback label `Fork`.
  - Resolved historical package-version bump conflicts to upstream during the
    rebase; the current fork release version is applied once at the end.

## Current Task: Resolve Nightly 230 Upstream Sync Rebase

Resolve the scheduled `Sync Upstream` failure for the nightly channel by
rebasing the fork onto upstream `v0.0.23-nightly.20260508.230`.

### Current User Requirements

- Prefer the pattern in the remote/upstream code.
- Reconcile the fork's branding changes against upstream's new desktop
  structure.
- Restore the GitHub nightly sync path so the fork can publish a
  `v0.0.23-nightly.20260508.230-fork.N` release.

### Constraints

- Keep the fork release/versioning model intact.
- Do not delete or rewrite existing release tags.
- Keep upstream's new desktop app module layout instead of reviving removed
  `apps/desktop/src/appBranding.*` files.
- Preserve externally visible fork branding where it still applies.
- Use `bun run test`, not `bun test`.

### Current Acceptance Criteria

- Rebase onto `refs/tags/upstream/v0.0.23-nightly.20260508.230` completes.
- The old `appBranding.*` conflict is resolved by porting fork branding into
  upstream's new `apps/desktop/src/app/DesktopEnvironment.ts` path.
- Focused desktop identity/environment tests pass.
- Required format/lint/typecheck gates pass or blockers are reported.
- If verified, push rebased `main` with `--force-with-lease` and push the next
  nightly fork tag for upstream `v0.0.23-nightly.20260508.230`.

### Current Status

- Rebase completed on branch `t3code/nightly-230-sync`.
- Upstream desktop module layout preserved; fork branding/flavor behavior was
  reconciled into `DesktopEnvironment`, `ElectronApp`, and `DesktopUpdates`.
- Pushed `main` and tag `v0.0.23-nightly.20260508.230-fork.1`.
- Release preflight exposed a separate nightly workflow bug: Electron tests now
  import the `electron` package, but nightly preflight installed dependencies
  with `--ignore-scripts`, leaving Electron incomplete.
- Preparing a follow-up workflow fix and `v0.0.23-nightly.20260508.230-fork.2`
  tag instead of rewriting the failed `-fork.1` tag.

### Current Verification

- Passed: `bun --filter @t3tools/desktop test src/app/DesktopEnvironment.test.ts src/app/DesktopAppIdentity.test.ts src/electron/ElectronApp.test.ts src/updates/DesktopUpdates.test.ts src/updates/updateChannels.test.ts`.
- Passed: `bun --filter @t3tools/scripts test build-desktop-artifact.test.ts resolve-previous-release-tag.test.ts` (only `build-desktop-artifact.test.ts` exists for the second path).
- Passed: `bun fmt`.
- Passed: `git diff --check`.
- Passed: `bun lint` with existing warnings only.
- Passed: `bun typecheck` with existing Effect language-service suggestions
  only.
- Blocked: `bun run test` reaches the server suite and fails because the local
  Node runtime is `22.15.1`, missing `node:sqlite` `StatementSync.columns`.
  The test error requires Node `>=22.16`, `>=23.11`, or `>=24`.
- GitHub: `Release` run `25589350595` failed in preflight desktop tests because
  Electron was not installed after the nightly `--ignore-scripts` install.

## Current Task: Trigger Headless Server Update Check From Newer Client

Let a newer desktop/web client ask an older headless server to check for a
GitHub release update immediately, without replacing the existing once-daily
timer.

### Current User Requirements

- Keep once-daily scheduled update checks.
- If the client version supersedes the server version, check for an update on
  the server.
- Keep the update path safe for a 24/7 headless service.

### Constraints

- Do not run the updater in-process.
- Do not put SSH/systemd details or secrets in the browser.
- Rate-limit client-triggered checks so reconnecting clients do not repeatedly
  hammer the server or GitHub.
- Keep unsupported/non-headless installs as a safe no-op.
- Use `bun run test`, not `bun test`.
- Repo checks required before done: `bun fmt`, `bun lint`, and
  `bun typecheck`.

### Current Acceptance Criteria

- Server exposes an authenticated RPC that requests an external headless update
  check and reports queued/cooldown/unsupported/error.
- The RPC uses the user systemd upgrade service when available, so the updater
  runs outside the T3 server process and can safely restart it.
- The web client triggers the RPC only when its version sorts newer than the
  connected server version.
- Client-triggered checks are rate-limited per environment/version pair.
- Documentation describes the once-daily timer plus newer-client immediate
  check behavior.
- Focused tests cover version supersedence logic and the trigger guard.

### Current Status

- Implemented locally; pending commit/push.
- Added authenticated `server.requestHeadlessUpdateCheck` websocket RPC.
- Added server-side headless update requester that starts
  `t3code-headless-upgrade.service` through `systemctl --user` with a cooldown.
- Added client-side version supersedence detection and per
  environment/client/server throttling before requesting a server check.
- Updated release docs and repo instructions to describe once-daily checks plus
  newer-client immediate checks.

### Current Verification

- Passed: `bun --filter @t3tools/web test src/versionSkew.test.ts src/serverUpdateCheck.test.ts`.
- Passed: `bun --filter @t3tools/web test src/serverUpdateCheck.test.ts src/environments/runtime/service.addSavedEnvironment.test.ts`.
- Passed: `bun --filter @t3tools/web test`.
- Passed: `bun --filter t3 test src/headlessUpdateCheck.test.ts`.
- Passed: `bun fmt`.
- Passed: `git diff --check`.
- Passed: `bun lint` with existing warnings only.
- Passed: `bun typecheck` with existing Effect language-service suggestions
  only.

## Current Task: Document And Install Headless Auto-Update

Document the correct update model for the Linux headless release artifact and
set up the remote VM to update from GitHub Releases safely.

### Current User Requirements

- Explain what happens if the headless app is running during an update.
- Document the chosen auto-update model in the repo.
- Set up auto-update on the remote `brad-linux-dev` T3 Code service.
- Keep the implementation safe for a 24/7 service.

### Constraints

- Do not mutate the running release directory in place.
- Stage new releases in versioned directories and atomically move a `current`
  symlink only after validation.
- Restart the service only after the new release has been downloaded,
  checksummed, extracted, and smoke-tested.
- Keep rollback possible.
- Keep secrets out of logs and chat output.
- Use `bun run test`, not `bun test`.
- Repo checks required before done: `bun fmt`, `bun lint`, and
  `bun typecheck`.

### Current Acceptance Criteria

- Repo docs describe the headless update policy, running-service behavior,
  rollback model, and systemd timer approach.
- A reusable updater script exists for installing newer GitHub release assets.
- The remote VM has the updater and timer installed.
- The remote updater can run safely when already current.
- `t3code.service` remains healthy and reports the expected version after
  setup.

### Current Status

- Completed locally and installed on the remote VM; pending commit/push.
- Added `scripts/headless-auto-upgrade.sh` as the reusable updater.
- Updated `docs/release.md` and `LLM_INSTRUCTIONS.md` to document the
  external updater model, running-service behavior, rollback, and systemd
  timer setup.
- Installed the updater on `brad-linux-dev` as
  `~/.local/bin/t3code-headless-upgrade`.
- Installed and enabled the user timer
  `t3code-headless-upgrade.timer`.
- Repointed the remote `t3` wrapper to
  `~/.local/share/t3code-server/current/bin/t3`, so the existing system
  service now runs through the documented `current` symlink.
- Note: `loginctl` reports `Linger=no`, so the user timer is active in the
  current user manager but will need `sudo loginctl enable-linger brad` or a
  root-owned system timer to run before login after VM reboot.

### Current Verification

- Passed: `bash -n scripts/headless-auto-upgrade.sh`.
- Passed: `git diff --check`.
- Passed: `bun fmt`.
- Passed: `bun lint` with existing warnings only.
- Passed: `bun typecheck` with existing Effect language-service suggestions
  only.
- Remote: updater staged `v0.0.23-fork.4` into
  `~/.local/share/t3code-server/releases/0.0.23-fork.4`.
- Remote: manual `systemctl --user start t3code-headless-upgrade.service`
  exited successfully with `already on 0.0.23-fork.4`.
- Remote: `t3code.service` is active and reports
  `serverVersion: "0.0.23-fork.4"` from
  `/.well-known/t3/environment`.

## Current Task: Replace Linux Electron Release With Headless Linux Artifact

Update the headless release-artifact branch so Linux releases publish the
headless server tarball instead of the Electron/AppImage desktop artifact.

### Current User Requirements

- Work from the existing `t3code/headless-release-artifact` branch.
- Bring the branch current with `main` and resolve conflicts.
- Replace the Linux Electron release artifact with the Linux headless artifact.
- Keep macOS desktop release artifacts intact.
- Keep the fork release/versioning model intact.
- Push the updated branch when verified.

### Constraints

- Do not delete or rewrite release tags.
- Avoid pushing directly to `main`; keep this on the feature branch/PR.
- Preserve package-version stamping behavior in release workflows.
- Use `bun run test`, not `bun test`.
- Repo checks required before done: `bun fmt`, `bun lint`, and
  `bun typecheck`.

### Current Acceptance Criteria

- PR branch is no longer conflicting with current `main`.
- `release.yml` no longer builds or publishes the Linux Electron/AppImage
  artifact.
- `release.yml` requires and publishes
  `t3-headless-${version}-linux-x64.tar.gz` for Linux.
- Release documentation and fork-specific instructions describe the new
  macOS desktop + Linux headless release matrix.
- Focused artifact tests and required repo checks pass, or blockers are
  reported.

### Current Status

- Completed locally; pending push/PR CI.
- Rebasing onto current `origin/main` succeeded after dropping a stale
  docs-only verification replay and preserving the current task tracker.
- Updated `release.yml` so the desktop build matrix contains only macOS arm64.
- Updated release publication to require the headless Linux x64 tarball and to
  reject Linux desktop assets (`*.AppImage` and `*-linux.yml`) if they appear.
- Updated `LLM_INSTRUCTIONS.md` and `docs/release.md` to describe the new
  macOS desktop + Linux headless release matrix.

### Current Verification

- Passed: `bun --filter @t3tools/scripts test build-headless-artifact.test.ts build-desktop-artifact.test.ts`.
- Passed: `git diff --check`.
- Passed: `bun fmt`.
- Passed: `bun lint` with existing warnings only.
- Passed: `bun typecheck` with existing Effect language-service suggestions
  only.
- Passed: `bun scripts/release-smoke.ts`.
- Passed: `PATH="$HOME/.nvm/versions/node/v22.22.1/bin:$PATH" bun run test`.
- Note: `bun run release:smoke` fails in this shell because its package script
  invokes Node directly and `/usr/local/bin/node` is `v22.15.1`; running the
  same script through Bun passed.

## Current Task: Fix Saved Environment Reconnect Spinner Hang

Troubleshoot and fix the case where `brad-linux-dev` reaches the remote
backend after the VM/server update but the frontend remains stuck in a
reconnecting UI state.

### Current User Requirements

- Troubleshoot the currently stuck reconnect state.
- Use local/remote logs and live connection evidence.
- Fix the repo code path if the frontend reconnect state can hang after the
  socket/auth path has already recovered.
- Keep secrets out of logs and chat output.

### Current Acceptance Criteria

- Confirm whether `brad-linux-dev` is reachable and auth/WebSocket connection
  attempts are succeeding.
- Identify why the UI can remain in reconnecting state despite backend reachability.
- Implement a focused fix that prevents manual saved-environment reconnects
  from hanging after the replacement connection receives its shell snapshot.
- Add a regression test for the stuck reconnect sequence.
- Run focused tests and report broader required checks if not run.

### Current Status

- Completed locally; pending commit/push/nightly release if this fix should ship
  immediately.
- Confirmed `brad-linux-dev` is active, serving
  `0.0.23-nightly.20260507.219-fork.1`, and has an established TCP connection
  from the Mac.
- Confirmed the saved environment record and remote auth session updated
  `lastConnectedAt` after the user retried reconnecting.
- Root cause: `connection.reconnect()` already resets the reconnect bootstrap
  gate before replacing the socket, but the shell subscription also reset the
  same gate on stream resubscribe. If the fresh shell snapshot arrived before
  the resubscribe hook ran, the snapshot could resolve the gate and then the
  hook could reset it again, leaving the UI stuck waiting.
- Implemented: removed the duplicate shell `onResubscribe` bootstrap reset and
  kept reconnect bootstrapping owned by `connection.reconnect()`.

### Current Verification

- Passed: `bun --filter @t3tools/web test src/environments/runtime/connection.test.ts`.
- Passed: `bun --filter @t3tools/web test src/environments/runtime/service.addSavedEnvironment.test.ts src/environments/runtime/service.threadSubscriptions.test.ts src/environments/runtime/connection.test.ts`.
- Passed: `bun fmt`.
- Passed: `bun lint` with existing warnings only.
- Passed: `bun typecheck` with existing Effect language-service suggestions
  only.

## Current Task: Deduplicate Remote Reconnect Fix And Ship Nightly

Compare the service-level saved-environment reconnect patch against the
browser-resume heartbeat freshness patch, keep the right behavior, remove
duplicate/conflicting retry logic, and deploy the result through the GitHub
nightly release path.

### Current User Requirements

- Compare `fix: auto-reconnect saved environments` against
  `fix(web): avoid healthy resume reconnects`.
- Deduplicate the implementation and keep the correct fix for frequent frontend
  disconnect/reconnect behavior.
- Verify the resulting code locally.
- Deploy the deduplicated fix through GitHub as a nightly version.

### Current Acceptance Criteria

- Healthy local and remote WebSocket connections are not force-reconnected on
  browser/window resume.
- Stale connections still reconnect on resume.
- There is no extra saved-environment service retry loop duplicating transport
  reconnect/resume behavior.
- Focused tests cover the kept behavior.
- Required repo checks pass: `bun fmt`, `bun lint`, and `bun typecheck`.
- A GitHub nightly release run is triggered and reported with concrete status.

### Current Status

- Implemented locally; pending commit/push/nightly release.
- Initial comparison: `origin/main` contains both patches stacked. The heartbeat
  freshness guard addresses the likely cause of frequent disconnects; the
  saved-environment service retry loop is a separate symptom-masking retry path
  and should be removed unless verification proves it is still required.
- Removed the saved-environment service retry loop and its retry-loop tests.
- Kept the heartbeat-fresh browser resume guard and its fresh/stale resume
  tests.

### Current Verification

- Passed: `bun --filter @t3tools/web test src/environments/runtime/service.addSavedEnvironment.test.ts src/environments/runtime/service.threadSubscriptions.test.ts src/environments/runtime/connection.test.ts`.
- Passed: `bun fmt`.
- Passed: `bun lint` with existing warnings only.
- Passed: `bun typecheck` with existing Effect language-service suggestions
  only.

## Current Task: Gate Browser Resume WebSocket Reconnects

Prevent healthy T3 Code frontend connections from briefly disconnecting and
reconnecting to both local and remote backends when the browser/window resumes.

### Current User Requirements

- Dig into the local frontend disconnect/reconnect behavior and build evidence
  one way or the other.
- Add the fix so healthy local and remote backend WebSocket connections are not
  force-reconnected on browser resume.
- Push the fix so a new build can be produced and installed.

### Current Acceptance Criteria

- Browser resume reconnects still recover stale or disconnected connections.
- Browser resume does not force-reconnect healthy/fresh connections.
- The behavior is covered by focused tests.
- The change is committed and pushed to the fork.
- A new release/build path is triggered or reported with concrete status.

### Current Status

- Completed locally; pending push/release verification.
- Evidence gathered: current code unconditionally calls `connection.reconnect()`
  for every registered environment on `visibilitychange`/`pageshow`, and the
  focused existing test proves that behavior.
- Implemented: browser resume now skips reconnecting environment connections
  whose WebSocket heartbeat is fresh while preserving reconnects for stale
  connections.

### Current Verification

- Passed: focused existing test confirming the current unconditional browser
  resume reconnect behavior before changing it.
- Passed: `bun run test -- --filter=@t3tools/web -- src/environments/runtime/service.threadSubscriptions.test.ts src/environments/runtime/connection.test.ts`.
- Passed: `bun fmt`.
- Passed: `bun lint` with existing warnings only.
- Passed: `bun typecheck` with existing Effect language-service suggestions
  only after `bun install --frozen-lockfile` refreshed local dependencies.

## Current Task: Investigate Frequent Remote Environment Disconnects

Investigate why the frontend frequently shows saved backend environments such
as `brad-linux-dev` as disconnected, and fix the client-side behavior if the
code path is responsible.

### Current User Requirements

- Investigate why the frontend frequently disconnects from connected backends.
- Use the screenshot state where `brad-linux-dev is disconnected` as the
  symptom to trace.
- Prefer evidence from local/remote logs, persisted environment configuration,
  and the connection lifecycle code.
- If the root cause is in this repo, implement the fix rather than only
  reporting the finding.

### Current Acceptance Criteria

- Identify whether the problem is backend service instability, network/tunnel
  instability, or frontend reconnect-state behavior.
- Saved remote environments recover automatically from transient WebSocket
  disconnects without requiring manual Reconnect for ordinary retryable
  failures.
- Avoid reconnect storms with bounded/backed-off retries.
- Add focused tests for saved-environment reconnect behavior.
- Run the required repo checks, or report any blockers.

### Current Status

- Completed.
- Found saved `brad-linux-dev` record points at `http://100.64.0.4:3773/`.
- Remote `t3code.service` is active and listening on `100.64.0.4:3773`.
- A fresh authenticated diagnostic WebSocket stayed open for 60 seconds.
- Root cause: saved environments get marked disconnected/error on transport
  close/error but do not have the same automatic reconnect driver as the
  primary WebSocket surface.
- Implemented service-level automatic reconnect for saved environments after
  unexpected WebSocket close/error, with one pending retry per environment and
  exponential backoff capped at 64 seconds.
- Manual saved-environment disconnect and successful reconnect clear pending
  automatic reconnect state.

### Current Verification

- Passed: `bun --filter @t3tools/web test src/environments/runtime/service.addSavedEnvironment.test.ts`.
- Passed: `bun fmt`.
- Passed: `bun lint` with existing warnings only.
- Passed: `bun typecheck` with existing Effect language-service messages only.

## Current Task: Stamp Server Version During Fork Releases

Fix the fork release pipeline so the remote/headless T3 Code server advertises
the fork release version instead of the stale upstream package version.

### Current User Requirements

- Make fork nightly releases stamp the server package/version source with the
  release version before building/publishing.
- Prevent local desktop clients from reporting version drift after connecting
  to the updated remote T3 Code server.
- Prefer the existing GitHub release/pipeline model for the fork.

### Current Acceptance Criteria

- Release builds use the requested/tagged release version for the server CLI
  version metadata.
- The change covers nightly fork releases such as
  `v0.0.23-nightly.20260506.213-fork.1`.
- The implementation is verified with focused local checks.
- Relevant release documentation is updated if the workflow contract changes.

### Current Status

- Completed: `sync-upstream.yml` now stamps releasable package versions and
  `bun.lock` before pushing stable/nightly release tags.
- Completed: `fork-interim-release.yml` now stamps releasable package versions
  and `bun.lock` before pushing `vNEXT-fork.N` tags.
- Completed: release documentation records that release tags must point at
  stamped commits for headless/tag-checkout installs.

### Current Verification

- Passed: `bun run --filter @t3tools/scripts test update-release-package-versions.test.ts`.
- Passed: `bun scripts/release-smoke.ts`.
- Passed: workflow YAML parse check with `yq`.
- Passed: `bunx oxfmt --check` on changed workflow/docs/tracker files.
- Passed: `bun fmt`.
- Passed: `bun lint` with existing warnings only.
- Passed: `bun typecheck`.
- Note: `bun run release:smoke` currently fails locally because the package
  script invokes `node scripts/release-smoke.ts`, and local Node v22.15.1 does
  not load `.ts` files directly. Running the same smoke script through Bun
  passed.

## Current Task: Fix macOS signing documentation

Update fork release documentation so it matches the current macOS signing and
notarization workflow.

### Current User Requirements

- Fix the stale documentation that says macOS artifacts are unsigned.
- Preserve the current release workflow behavior: macOS signing/notarization is
  enabled only when the required Apple Developer ID and App Store Connect
  secrets are present.
- Do not inspect or print secret values.
- Keep the change documentation-only unless a real workflow gap is found.

### Current Acceptance Criteria

- `LLM_INSTRUCTIONS.md` accurately describes macOS signing/notarization and
  the required secret names.
- `docs/release.md` matches the current release signing behavior.
- Required repo checks are run, or any skipped checks are reported.

### Current Status

- Completed: updated `LLM_INSTRUCTIONS.md` and `docs/release.md` to describe
  the current conditional macOS signing/notarization path.
- Confirmed the latest release run logged `macOS signing enabled`, Developer ID
  signing, and successful notarization for
  `v0.0.23-nightly.20260506.212-fork.1`.
- Verified with `bun fmt`, `bun lint`, and `bun typecheck`.

## Current Task: May 6 Minimal Main Rewrite

Repair Brad's fork sync by rewriting `origin/main` to a minimal fork stack on
top of the latest upstream nightly while preserving custom fork features.

### Current User Requirements

- Keep Brad's fork as minimal as possible while maintaining custom features.
- Preserve the fork desktop identity and updater lanes documented in
  `LLM_INSTRUCTIONS.md`.
- Keep mobile overlay work on `origin/feature/mobile-track`, not merged into
  `main`.
- Create a remote backup of the current `origin/main` before rewriting it.
- Rebase the minimal fork maintenance stack onto the latest upstream nightly
  available at execution time.
- Run `bun fmt`, `bun lint`, and `bun typecheck` before considering the rewrite
  complete.
- Push rewritten `origin/main` with `--force-with-lease` and publish the next
  fork nightly tag for the upstream nightly.

### Current Acceptance Criteria

- Current `origin/main` is preserved in a backup remote ref.
- Rewritten `main` is based on the latest upstream nightly tag and excludes
  mobile-only overlay commits and release-finalizer noise.
- Fork branding, release automation, updater behavior, and fork-specific fixes
  remain in the rebased stack.
- Required checks pass.
- Pushed refs, workflow URLs, and any blockers are reported.

### Current Status

- In progress.
- Backup branch `backup/main-before-minimal-rewrite-20260506` was pushed at
  `1f189f6b7338201e8ec966305f2a48a1411db035`.
- Latest upstream nightly at execution time is
  `v0.0.23-nightly.20260506.212`
  (`166bce0389e2068ae48c5936692eb315b17a269d`).
- Minimal fork stack rebased cleanly onto
  `refs/tags/upstream/v0.0.23-nightly.20260506.212`.
- Mobile branch remains separate at
  `a39ad591697ed71b543e6d3777a9f8c1f97f3a05`.

## Current Task: Preserve LAN Backend Pairing Fix

Save the useful LAN/Tailscale backend pairing changes from the cleanup stash,
commit them on a fresh branch, merge them into main, and clean up the stale
checkpoint fallback feature branch.

### Current User Requirements

- Keep the changes from the stash that are worth saving.
- Put the kept changes on a new branch.
- Commit the kept changes.
- Merge the committed changes into main.
- Clean up the old checkpoint revert feature branch.

### Current Acceptance Criteria

- The LAN/Tailscale backend pairing fix and focused tests are committed.
- Stale release workflow/doc stash changes are not committed.
- The new commit is merged into local main.
- The old checkpoint revert feature branch is removed when no longer needed.
- Repo-required checks are run, or any skipped checks are reported.

### Current Status

- Completed: restored only the LAN/Tailscale remote backend pairing changes
  from the cleanup stash.
- Completed: stale hosted macOS fallback workflow/doc stash changes were left
  out because current `origin/main` already contains the cleaner version.
- Verified: focused remote API test, `bun fmt`, `bun lint`, and
  `bun typecheck` pass.

## Current Task: Hosted macOS fallback for release builds

Allow release builds to proceed when Brad's local Apple Silicon runner is not
available, then kick off a build for the latest upstream nightly with current
fork commits rebased on top.

### Current User Requirements

- Commit the current release-runner fallback changes.
- If the local macOS runner is unavailable or busy, use a GitHub-hosted macOS
  runner instead of leaving the macOS release job queued indefinitely.
- Preserve the fork's normal preference for the local `t3code-mac-arm64`
  runner when it is online and idle.
- Build the latest upstream nightly with our rebased fork commits, including
  macOS desktop app changes and iOS/mobile app changes.
- Preserve unrelated dirty local work in other worktrees.

### Current Acceptance Criteria

- `release.yml` chooses the self-hosted macOS runner when online/idle and
  chooses GitHub-hosted macOS when the local runner is unavailable or busy at
  preflight time.
- The limitation that GitHub Actions cannot migrate an already queued
  self-hosted job is documented.
- The change is committed and pushed to the fork.
- The latest nightly release build is rerun from the fixed workflow.
- The resulting run status and any remaining blockers are reported.

### Current Status

- In progress.

## Current Task: Repair May 2 Nightly Sync Failure

Investigate and repair failing scheduled nightly upstream sync runs after the
user received "nightly needs attention" emails.

### Current User Requirements

- Look into the nightly release/sync attention emails.
- Identify the failing workflow and concrete blocker.
- Repair the fork nightly sync path if the fix is clear and safe.
- Preserve existing dirty local work and untracked worktrees.
- Do not delete releases/tags or expose secrets.

### Current Acceptance Criteria

- Latest failed nightly run and upstream nightly tag are identified.
- The rebase conflict is reproduced and resolved locally.
- `main` is updated with the rebased fork commits if verification passes.
- A new fork nightly tag/release is created for the upstream nightly.
- GitHub Actions run(s), release assets, and local runner state are verified.

### Current Status

- In progress.
- Latest failing scheduled run: `25262598575` (`Sync Upstream`).
- Stable sync is clean; nightly sync fails rebasing onto
  `v0.0.22-nightly.20260502.184`.
- Conflict file: `.github/workflows/release.yml`.

## Current Task: Cancel stacked nightly release builds

Stop multiple queued nightly tag-push runs from all building when only the most
recent one matters. Also confirm the local self-hosted macOS runner is healthy.

### Current User Requirements

- If multiple nightly release runs are queued/in-progress, only the most recent
  upstream nightly should build; older nightly runs should be cancelled.
- Stable releases (incl. fork-interim `vNEXT-fork.N`) and manual
  `workflow_dispatch` runs must NOT be cancelled by this change.
- Confirm the local Apple Silicon self-hosted macOS runner is online and
  processing the queue without stuck/zombie state.
- Land the fix on `main` so it applies to future nightly tag pushes.
- Document the new behavior in `LLM_INSTRUCTIONS.md` / `docs/release.md`.

### Current Acceptance Criteria

- `release.yml` puts nightly tag-push runs in a single shared concurrency group
  with `cancel-in-progress: true`; stable/dispatch runs keep per-run groups.
- Existing redundant queued/in-progress nightly runs (`.157`, `.158`) are
  cancelled so the runner can pick up `.161` (latest) instead.
- `v0.0.22-fork.1` (stable fork-interim, in queue) is left intact.
- Local mac runner status: online, busy/idle as expected, no stuck workers.
- Docs updated to describe the new "newer nightly cancels older" behavior.

### Current Status

- In progress.

## Current Task: Check and repair nightly GitHub Actions

Investigate why the user did not receive the April 27 nightly update, unblock
the queued nightly release, and harden the sync workflow if a repeatable Actions
failure is found.

### Current User Requirements

- Check whether GitHub Actions are working for nightly release tracking.
- Determine why no new nightly update was available today.
- Unblock or repair the workflow if a clear issue is found.
- Keep release automation safe: do not delete releases/tags or expose secrets.

### Current Acceptance Criteria

- The latest upstream nightly state is identified.
- The fork's sync/release workflow state is inspected from live GitHub Actions.
- The queued nightly release is either completed or the remaining blocker is
  clearly identified.
- Any repeatable workflow failure found during the check is fixed and verified.

### Current Status

- Completed: upstream published `v0.0.22-nightly.20260427.135`.
- Completed: fork tag `v0.0.22-nightly.20260427.135-fork.1` exists and its
  release run was queued on the offline self-hosted macOS runner.
- Completed: started the TTL-limited local runner so the queued release can
  continue.
- Completed: manual `sync-upstream` nightly dispatch failed because the
  workflow's REST release-list query returned no upstream nightly; patching the
  query to use `gh release list --json`.
- Verified: replacement query resolves `v0.0.22-nightly.20260427.135` locally;
  YAML parsing and `git diff --check` pass.
- Completed: patched and pushed `sync-upstream.yml`; CI and manual nightly sync
  now pass and identify the latest upstream nightly.
- Found: both tag-push rerun and manual `release.yml` dispatch rebuilt artifacts
  successfully but failed at GitHub release creation with `403 Resource not
accessible by integration`, even though the job received `contents: write`.
- Completed: update `release.yml` to use the repo PAT for release creation
  when available, with `github.token` fallback, and add a manual `target_ref`
  recovery input so the fixed `main` workflow can build/publish an existing tag.
- Found: fixed-workflow recovery run `25009285649` failed before publishing
  because nightly preflight ran full dependency lifecycle scripts and `bun
install` was killed with exit 143 after resolving packages.
- Completed: make nightly preflight installs use `--ignore-scripts` while
  leaving stable preflight/build installs full.
- Completed: recovery run `25009607368` passed from the fixed `main` workflow,
  publishing `v0.0.22-nightly.20260427.135-fork.1` as a prerelease targeting
  `1182813ffd620f141847203cebe816abf36366ee`.
- Verified: release assets include `nightly-mac.yml`, macOS arm64 zip/dmg and
  blockmaps, `nightly-linux.yml`, and Linux AppImage.
- Follow-up: push CI runs for the workflow/doc commits failed only at `bun fmt`
  against this tracker file; local `bun fmt` corrected the formatting.

## Current Task: Commit And Push Checkpoint Revert Fix

Publish the checkpoint revert fix to Brad's T3 Code fork so the fork build
pipeline can produce an updateable local version.

### Current User Requirements

- Commit the checkpoint revert fix.
- Push it to the fork.
- Target the rebuild/update path; local dev server update will happen after
  the local version is updated.

### Current Acceptance Criteria

- Commit contains only the checkpoint revert fix, regression tests, and task
  tracker updates.
- Commit is pushed to the fork branch that triggers the intended build path.
- Report commit SHA and push target.

### Current Status

- In progress.

## Current Task: Checkpoint Revert Session Binding Investigation

Troubleshoot and fix frequent checkpoint revert failures that report:
`No active provider session with workspace cwd is bound to this thread.`

### Current User Requirements

- Diagnose why checkpoint revert frequently fails with the missing active provider session error.
- Prefer a robust fix over a surface-level explanation.
- Preserve unrelated release-work changes and untracked files.

### Current Acceptance Criteria

- Identify the code path that emits the failure.
- Add focused regression coverage for the failing path.
- Make checkpoint revert work when the thread has a persisted workspace path even if no live provider session appears in `listSessions()`.
- Run the relevant focused tests, and report any broader checks not run.

### Current Status

- Completed: checkpoint revert now resolves its filesystem workspace from the
  live provider session when available, otherwise from the persisted
  `thread.worktreePath` / project workspace root.
- Completed: added regression coverage for reverting when
  `providerService.listSessions()` returns no active session.
- Verified: the new regression fails when the workspace fallback is removed.
- Verified with focused server tests, orchestration integration tests,
  `bun fmt`, `bun lint`, `bun typecheck`, and `git diff --check`.

## Current Task: Final Cleanup

Remove the low-value leftovers from the release repair work.

### Current User Requirements

- Remove the local untracked `apps/server/t3-0.0.21.tgz` artifact.
- Remove canceled GitHub workflow runs that only represent the accidental
  interim release attempt and the old stuck CI run.
- Leave real releases, successful runs, and required tags intact.

### Current Acceptance Criteria

- Local working tree has no untracked cleanup artifact.
- Canceled cleanup-target runs are gone from the recent GitHub Actions list.
- No `v0.0.22-fork.1` tag or release exists.
- Current successful releases remain intact.

### Current Status

- Completed: removed local `apps/server/t3-0.0.21.tgz`.
- Completed: deleted canceled workflow runs `24908811347` and `24908784560`.
- Verified: recent Actions list no longer includes those canceled runs,
  `v0.0.22-fork.1` has no remote tag, and the current stable/nightly releases
  remain present.

## Current Task: CI and Fork-Interim Trigger Hardening

Implement the follow-up recommendation to prevent accidental releases and
unblock CI.

### Current User Requirements

- Narrow `fork-interim-release.yml` so docs, workflow, and helper-script
  maintenance cannot accidentally publish a fork-only stable desktop update.
- Move CI off the currently unavailable `blacksmith-8vcpu-ubuntu-2404` runner.
- Keep documentation current for future agents.
- Do not disturb existing untracked user files.

### Current Acceptance Criteria

- Fork-interim release creation only triggers for paths that can affect the
  packaged desktop/runtime build.
- CI jobs use an available hosted runner.
- The old queued CI run on the unavailable runner is not left hanging.
- Relevant docs describe the narrowed fork-interim trigger behavior.
- Changes are verified with repo-required checks where practical.

### Current Status

- Completed: `fork-interim-release.yml` now uses a narrow path allowlist for
  packaged app/runtime/build inputs, and CI now runs on `ubuntu-24.04`.
- Completed: canceled the old queued CI run waiting on the unavailable
  Blacksmith runner.
- Verified with `git diff --check`, YAML parsing, `bun fmt`, `bun lint`, and
  `bun typecheck`.

## Current Task: Documentation Cleanup

Clarify and streamline release/update documentation so future agents can work
efficiently from a cold start.

### Current User Requirements

- Make the documentation clear and up to date.
- Thin out unnecessary or stale detail.
- Preserve the operational guidance agents need for the fork release/update
  workflow.
- Reflect the updater path that was validated by installing
  `v0.0.22-nightly.20260423.108-fork.1` and detecting
  `v0.0.22-nightly.20260423.108-fork.2`.

### Current Acceptance Criteria

- `LLM_INSTRUCTIONS.md` gives future agents a concise fast path for stable,
  nightly, and rerolled updater-test releases.
- `docs/release.md` matches the current workflow and avoids obsolete setup
  detail that can mislead agents.
- Documentation calls out any known workflow quirks that are still true.
- Existing fork patches and local untracked user files are not destroyed.

### Current Status

- Completed: release/update docs now contain a concise fast path, current
  reroll guidance, updater verification notes, and no obsolete Windows/Azure
  signing setup checklist.
- Verified with `git diff --check`, `bun fmt`, `bun lint`, and
  `bun typecheck`.

## Task

Repair the T3 Code fork automation so the fork follows upstream stable and nightly releases reliably.

## User Requirements

- Use Brad's local Apple Silicon Mac as an on-demand GitHub Actions macOS build worker.
- Do not configure the runner to launch at startup.
- Runner must be time-limited so it shuts off automatically if forgotten.
- Document this preference in a reusable skill or shared instruction location.
- Update release workflow so macOS builds target the local self-hosted runner, while Linux remains hosted.
- Keep a fork of upstream `pingdotgg/t3code` that rebases Brad's fork commits onto new upstream releases automatically.
- Track both stable releases and nightly releases.
- Prefer salvaging the current fork unless restarting from upstream is clearly better.
- Clean up the prior botched implementation enough that the system works.

## Acceptance Criteria

- Self-hosted macOS runner can be started manually with a timeout.
- Release workflow routes macOS arm64 build to the self-hosted runner label.
- Shared skill documents the management preference and commands.
- Main-branch fork-only changes automatically create the next updater-visible stable interim tag (`vNEXT-fork.N`) without waiting for upstream.
- Scheduled sync checks both stable and nightly, not only one selected channel.
- Stable and nightly sync replay only fork commits onto the selected upstream tag; stable releases must not accidentally include upstream nightly commits.
- Nightly fork tags use the fork-specific `-fork.N` scheme and do not create bare upstream-style nightly tags.
- Manual release/sync paths cannot accidentally recreate bare non-fork nightly releases.
- Stable `v0.0.21` can be recovered/published if upstream has it and the fork release is missing.
- Fork-only stable tags like `v0.0.22-fork.1` publish as normal/latest releases so installed stable fork clients receive updates.
- Documentation matches the implemented workflow.
- Existing fork patches and local untracked user files are not destroyed.
- Nightly updater feed must not be poisoned by orphan tag-only entries that lack
  `nightly*.yml` release assets.
- Nightly macOS updater releases must still publish when the hosted Linux
  artifact build fails, as long as the macOS updater manifest exists.
- Release publication jobs must avoid native dependency lifecycle scripts when
  they only need helper scripts and artifact upload.
- Nightly preflight/Linux builds must not hold the macOS updater release open
  on native dependency lifecycle hangs; stable preflight/Linux builds should
  keep the full install.
- Troubleshoot why OpenCode-backed threads lose model continuity after an idle
  gap or provider-session recovery.
- Persist and reuse the OpenCode provider session id so recovered turns continue
  the same OpenCode conversation instead of starting a blank session.
- Commit, merge, and push the OpenCode continuity fix.
- Ensure macOS release builds do not get stuck or fail when the local Mac runner
  is not online.
- Prefer the local Mac runner only when release preflight can confirm the
  `t3code-mac-arm64` runner is online and idle.
- Fall back to GitHub-hosted macOS infrastructure when the runner is offline,
  busy, or the workflow lacks permission to query self-hosted runner state.
- Persist the local Mac build-agent lessons in repo docs and shared
  agent-facing workflow notes so future agents can repeat the setup without
  rediscovering the same failure modes.

## Constraints

- Follow repo instructions: `bun fmt`, `bun lint`, and `bun typecheck` must pass before completion.
- Do not run `bun test`; use `bun run test` for Vitest.
- Keep the OpenCode status fix scoped to provider/thread lifecycle state.
- Preserve existing OpenCode session-resume behavior.
- Keep the new-thread fix scoped to the new-thread/worktree failure path.
- Keep release workflow changes scoped to the push-triggered fork build path,
  release docs, and agent-facing release instructions.
- Keep the OpenCode continuity fix scoped to provider resume behavior and
  focused regression coverage.
- Keep the local Mac runner on-demand/time-limited and avoid exposing GitHub
  runner registration tokens in logs or chat.
- Do not require a self-hosted runner for normal releases when the local Mac is
  unavailable.
- Do not print or commit any GitHub runner/API token used for runner discovery.

## Acceptance Criteria

- OpenCode-backed turns emit or project a terminal state when provider work is
  finished.
- The web UI no longer derives "Working" for a completed OpenCode-backed thread
  once the latest turn is settled.
- Focused regression coverage proves the completed OpenCode path clears working
  state.
- The OpenCode stale-working fix is committed, merged to the intended branch,
  and pushed to the remote.
- A project with an initialized but unborn git branch does not try to create a worktree from an invalid `main` ref.
- New thread send can proceed from the current checkout when there is no valid worktree base ref.
- Focused regression tests cover the fallback.
- The fix commit is pushed to the intended GitHub branch.
- The macOS GitHub Actions build is identified and monitored to completion or a clear blocker.
- A normal push to `main` no longer creates `vNEXT-fork.N` as a stable/latest
  release.
- A normal push to `main` creates a fork nightly based on the latest upstream
  nightly tag and dispatches `release.yml` for that nightly.
- The next upstream stable sync still rebases fork commits onto the stable tag
  and publishes the integrated stable release.
- OpenCode-backed threads persist a `{ sessionId }` resume cursor.
- OpenCode recovery starts from the saved session id or, for older uncursored
  threads, an exact-title matching OpenCode session, rather than creating a
  blank session.
- T3 Code macOS arm64 release jobs prefer the local self-hosted runner label
  `t3code-mac-arm64` only after preflight confirms it is online and idle.
- The local runner can be started/stopped/status-checked using the existing
  `t3code-mac-runner` helper.
- Release preflight reaches macOS runner resolution instead of failing desktop
  tests because the Electron executable is missing.
- If the runner probe cannot confirm an online idle `t3code-mac-arm64` runner,
  `release.yml` resolves macOS arm64 builds to GitHub-hosted `macos-15`.
- If a suitable token is available and the runner is online/idle, `release.yml`
  resolves macOS arm64 builds to
  `["self-hosted","macOS","ARM64","t3code-mac-arm64"]`.
- Repo docs and the shared local-runner skill document the fallback behavior,
  optional runner-state token, and repeatable `t3code-mac-runner` workflow.

## Open Questions / Proposed Changes

- None.

## Status

- Complete: double-check showed `OrchestrationEngine` projects events before
  publishing shell-stream events, so a WebSocket-before-SQLite projection race is
  not the supported root cause.
- Complete: live `state.sqlite` for thread
  `46c06c73-cf76-498e-b017-d577f833d6a6` still has
  `projection_thread_sessions.status = 'running'` with stale active turn
  `opencode-turn-d1655dab-df05-4577-9bb3-250dfb73453b`, while later OpenCode
  turns are completed. The fix must repair provider lifecycle/session state, not
  only shell-stream event mapping.
- Complete: provider runtime ingestion now accepts lifecycle events for the
  provider runtime's current active turn when the persisted projected active turn
  is stale, allowing the next current-turn completion to clear `Working`.
- Complete: OpenCode terminal assistant-message updates now settle the active
  turn when OpenCode omits a `session.status` idle event, clearing stale
  "Working" UI state while preserving resume behavior.
- Complete: OpenCode stale-working fix committed, merged into `main`, and
  pushed to `origin/main`.
- Complete: thread fix is pushed; release build completed; push-triggered fork
  builds now publish through the nightly channel and remain integrated into the
  next upstream stable sync.
- Complete: OpenCode continuity fix is implemented, verified, merged into
  `main`, and pushed.
- Complete: local Mac runner is online; CI/release Electron binary install was successfully committed and verified, enabling preflight to resolve macOS runners.
- Complete: release preflight now falls back to GitHub-hosted `macos-15` when
  the local Mac runner is unavailable or runner-state probing is not authorized.
- Complete: reusable local Mac runner lessons are documented in `docs/release.md`,
  the shared `github-actions-local-runner` skill, and shared T3 Code memory.

## Verification

- Passed: `bun run --filter t3 test -- src/provider/Layers/OpenCodeAdapter.test.ts -t "settles a turn"`.
- Verified regression catch: temporarily disabled terminal-finish detection and
  the focused test failed because `turn.completed` was missing.
- Passed: `bun run --filter t3 test -- src/provider/Layers/OpenCodeAdapter.test.ts`.
- Passed: `bun fmt`.
- Passed: `bun lint` with 9 pre-existing warnings and 0 errors.
- Passed: `bun typecheck`.
- Passed after rebase onto `origin/main`: `bun run --filter t3 test -- src/provider/Layers/OpenCodeAdapter.test.ts`.
- Passed after rebase onto `origin/main`: `bun fmt`.
- Passed after rebase onto `origin/main`: `bun lint` with 9 pre-existing warnings and 0 errors.
- Passed after rebase onto `origin/main`: `bun typecheck`.
- Passed: `bun --filter @t3tools/web test src/components/ChatView.logic.test.ts`.
- Passed: `bun --filter @t3tools/web test -- --config vitest.browser.config.ts src/components/ChatView.browser.tsx -t "falls back to current checkout"`.
- Passed: `bun fmt`.
- Passed: `bun lint` with 9 pre-existing warnings and 0 errors.
- Passed: `bun typecheck`.
- Passed: Release run `26261249116` completed, including `Build macOS arm64`,
  `Build headless Linux x64`, `Publish GitHub Release`, and `Finalize release`.
- Verified: `v0.0.25-fork.4` is published with macOS DMG/zip, updater manifest,
  blockmaps, and Linux headless asset.
- Passed: YAML parse check for `.github/workflows/fork-push-nightly.yml`.
- Passed: `git diff --check`.
- Passed: CI run `26261679727` for `c259adf0c`, including release smoke,
  format, lint, typecheck, tests, browser tests, desktop pipeline build, and
  preload bundle verification.
- Verified: pushing the workflow/docs change started CI only; it did not start
  another release/nightly build.
- Confirmed from the live `state.sqlite` and provider log that
  `194f1cc3-0954-4d7d-be51-f5bc0fabe4a1` is an OpenCode thread whose
  `provider_session_runtime.resume_cursor_json` was `null`; the follow-up turn
  ran in a different OpenCode session id than the prior deployment turn.
- Passed: `bun --filter t3 test -- src/provider/Layers/OpenCodeAdapter.test.ts`.
- Passed: `bun fmt`.
- Passed: `bun lint` with 9 existing warnings and 0 errors.
- Passed: `bun typecheck`.
- Verified: Release run `26552666470` failed before runner resolution because
  Ubuntu preflight desktop tests could not resolve the Electron executable after
  dependency install.
- Verified: `t3code-mac-runner start 7200` started the local runner in detached
  `tmux`; GitHub reports `t3code-mac-macbookpro` online, idle, and labeled
  `t3code-mac-arm64`.
- Passed: `bun run install:electron`.
- Passed: `bun --filter '@t3tools/desktop' test`.
- Passed: `git diff --check`.
- Partial: `bun run test` passed through desktop and web packages locally, then
  the server Vitest process stopped producing output and was terminated.
- Verified: Release run `26553119701` passed the first explicit Electron install
  step but still failed desktop tests because the helper did not verify the
  executable was present.
- Added: `scripts/install-electron-binary.mjs` clears skip flags, runs Electron's
  installer, verifies the platform executable, and retries once after removing a
  stale `dist`/`path.txt`.
- Verified: CI run `26553321559` failed fast in `install:electron`; the verifier
  reported that Linux `dist/electron` was still missing, so the helper now pins
  Electron's installer to the current runner `npm_config_platform` and
  `npm_config_arch`.
- Updated: after CI run `26553427131` showed the pinned installer still produced
  only `dist/locales`, the helper now falls back to direct `@electron/get`
  download/extract and writes Electron's `path.txt` itself.
- Updated: release run `26553548478` hit Node's unsettled top-level-await exit
  path while using `@electron/get`; the fallback now uses synchronous `curl`
  plus `unzip` against Electron's published artifact URL.
- Verified: release run `26553695852` passed preflight through Electron install,
  lint, typecheck, and tests, but its runner API check returned HTTP 403 and
  fell back to GitHub-hosted `macos-15`. The workflow now routes macOS arm64
  directly to the `t3code-mac-arm64` self-hosted label.
- Verified: release run `26554025503` completed successfully for
  `v0.0.25-nightly.20260515.295-fork.8`; preflight passed, macOS arm64 built on
  the local `t3code-mac-macbookpro` runner in 7m24s, and the release published
  the notarized DMG/ZIP plus the headless Linux tarball.
- Passed: release workflow YAML parses with Ruby's YAML parser.
- Passed: extracted "Resolve macOS runner" shell passes `bash -n`.
- Passed: runner resolution simulation with no token emits `runner="macos-15"`.
- Passed: runner resolution simulation with an unauthorized token emits
  `runner="macos-15"`.
- Passed: runner resolution simulation with a fake online runner emits
  `runner=["self-hosted","macOS","ARM64","t3code-mac-arm64"]`.
- Verified regression catch: the new stale-active-turn provider ingestion test
  failed before the fix with `Timed out waiting for thread state`.
- Passed: `bun run --filter t3 test -- src/orchestration/Layers/ProviderRuntimeIngestion.test.ts -t "recovers lifecycle state"`.
- Passed: `bun run --filter t3 test -- src/orchestration/Layers/ProviderRuntimeIngestion.test.ts`.
- Passed: `bun fmt`.
- Passed: `bun lint` with existing warnings only.
- Passed: `bun typecheck`.

## User-Approved Requirement Changes

- None.
