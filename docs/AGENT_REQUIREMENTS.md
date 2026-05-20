# Agent Requirements

## Current Task: Fix Mobile Test Suite And Publish EAS Update

Fix the full mobile Vitest suite blocker, then commit and push the mobile
reconnect fix so the GitHub mobile EAS workflow runs successfully and publishes
the update.

### Current User Requirements

- Fix the mobile test suite failure.
- Push the reconnect fix branch.
- Make sure the GitHub run succeeds.
- Make sure the successful GitHub run publishes the EAS update.

### Constraints

- Continue working in `/tmp/t3-mobile-sync` on the current mobile branch.
- Preserve unrelated worktree/user changes.
- Follow `LLM_INSTRUCTIONS.md` and root `AGENTS.md`.
- Do not run `bun test`; use `bun run test`.
- Do not inspect or print secrets; rely on GitHub/EAS configured credentials.

### Acceptance Criteria

- `bun run --filter @t3tools/mobile test` passes locally.
- Required local gates pass, or any pre-existing blocker is documented.
- A commit containing the reconnect fix and test-suite fix is pushed to the
  mobile branch.
- The GitHub `Mobile Track EAS Update` workflow for that pushed commit
  completes successfully.
- The workflow's publish step confirms an EAS update was published.

### Status

- Completed: requirements captured before test-suite edits.
- Completed: fixed the mobile Vitest suite blocker by extracting
  `resolveSelectedThreadStopPlan` into a pure module that does not import
  React Native hooks/runtime modules.
- Completed: full mobile Vitest suite now passes locally.
- Completed: added the full mobile Vitest suite to the mobile-track GitHub EAS
  workflow before the EAS publish step.
- In progress: committing, pushing, and monitoring GitHub EAS publication.

### Verification

- Passed: `bun run --filter @t3tools/mobile test src/state/use-selected-thread-commands.test.ts`.
- Passed: `bun run --filter @t3tools/mobile test`.
- Passed: `bun run --filter @t3tools/mobile typecheck`.
- Passed: `NODE_OPTIONS=--experimental-strip-types bun lint:mobile`.
- Passed: `bun fmt`.
- Passed: `bun run fmt:check`.
- Passed: `bun typecheck`.
- Passed with existing warnings only:
  `NODE_OPTIONS=--experimental-strip-types bun lint`.
- Blocked: plain `bun lint` fails before linting because Node cannot load
  `oxlint-plugin-t3code/index.ts` without type stripping.

### User-Approved Requirement Changes

- None.

## Current Task: Fix Mobile Reconnect Runtime State

Implement the approved reconnect-state plan for the mobile app after live iOS
diagnostics showed WebSockets reopening while runtime state stayed
`disconnected` with a stale socket error.

### Current User Requirements

- Implement the detailed implementation plan for mobile reconnect reliability.
- Fix stale mobile runtime state after successful WebSocket reconnect/open.
- Preserve cached shell snapshots and saved connections.
- Keep `ready` gated on shell snapshot sync, not WebSocket open alone.
- Add regression coverage for the reconnect state transition and watchdog.

### Constraints

- Work in the mobile sync worktree for the current mobile branch.
- Preserve unrelated existing worktree changes.
- Follow branch rules in `LLM_INSTRUCTIONS.md` and root `AGENTS.md`.
- Do not run `bun test`; use `bun run test`.
- Before considering completion, run repo-required checks where feasible:
  `bun fmt`, `bun lint`, and `bun typecheck`; use documented local
  workarounds only when plain lint is blocked by the existing TypeScript plugin
  loader issue.

### Acceptance Criteria

- A new WebSocket attempt/open clears stale socket errors and moves runtime to
  `connecting` or `reconnecting` instead of remaining hard `disconnected`.
- WebSocket open alone never marks an environment `ready`.
- Shell snapshot sync remains the only path back to `ready`.
- If a reconnect opens but shell snapshot does not resume promptly, mobile
  records an explicit diagnostic and surfaces a clear shell-resume timeout
  error instead of the stale socket error.
- Focused regression tests cover the stale disconnected/error case and the
  shell-resume watchdog behavior.
- Required verification is run, or blockers are documented with concrete
  errors.

### Status

- Completed: requirements captured before implementation edits.
- Completed: added testable reconnect-state helpers for WebSocket attempt/open
  transitions and shell-resume watchdog behavior.
- Completed: wired saved mobile environment connections to clear stale socket
  errors on attempt/open, keep `ready` gated on shell snapshots, and record
  `mobile.rpc.subscribe.shell.resume_timeout` if shell state does not resume.
- Completed: documented the new shell-resume timeout breadcrumb in
  `docs/mobile-ios-debugging.md`.
- Completed: verified the new regression test fails when the stale
  `disconnected` preservation behavior is reintroduced, then restored the fix.
- Blocked: full mobile test suite currently fails while loading existing
  `src/state/use-selected-thread-commands.test.ts` because Vite/Rolldown
  cannot parse Flow syntax from `react-native/index.js`; this occurs after 26
  mobile test files and 95 tests pass.

### Verification

- Passed: `bun run --filter @t3tools/mobile test src/state/remote-environment-reconnect.test.ts`.
- Passed: `bun run --filter @t3tools/mobile typecheck`.
- Passed: `bun fmt`.
- Passed: `NODE_OPTIONS=--experimental-strip-types bun lint:mobile`.
- Passed: `bun typecheck`.
- Passed with existing warnings only:
  `NODE_OPTIONS=--experimental-strip-types bun lint`.
- Blocked: plain `bun lint` fails before linting because Node cannot load
  `oxlint-plugin-t3code/index.ts` without type stripping.
- Blocked: `bun run --filter @t3tools/mobile test` fails on the existing React
  Native Flow parse issue noted above.

### User-Approved Requirement Changes

- None.

## Current Task: Diagnose And Fix Mobile Thread Stop Button

Review the iOS/mobile thread stop control on the latest mobile branch in an
isolated worktree, determine why tapping Stop in a thread view does nothing,
and implement the smallest robust fix with regression coverage.

### Current User Requirements

- Use a new worktree.
- Use the most recent branch that contains the iOS/mobile app instead of
  `main`.
- Review the iOS/mobile implementation of the thread stop button.
- Determine why pressing Stop in a thread view does nothing.
- Fix the issue if the cause is clear from the implementation review.

### Constraints

- Work from the newest mobile branch carrying `apps/mobile`, identified as
  `origin/feature/mobile-track`.
- Preserve unrelated existing changes in the repo and other worktrees.
- Before considering the task complete, run `bun fmt`, `bun lint`, and
  `bun typecheck` per repo instructions.
- Do not run `bun test`; use `bun run test`.

### Acceptance Criteria

- The root cause of the inert mobile Stop action is identified concretely.
- The mobile Stop control dispatches the correct behavior for active turns
  and queued sends.
- Regression coverage exists for the broken stop-decision path.
- Required verification is run, or concrete blockers are documented.

### Status

- Completed: loaded shared and repo instructions, then identified
  `origin/feature/mobile-track` as the newest mobile branch.
- Completed: created isolated worktree
  `.worktrees/review-ios-stop-button` from `origin/feature/mobile-track`.
- Completed: identified two concrete causes for the inert Stop control:
  mobile showed Stop when queued sends existed, but the handler only attempted
  a live turn interrupt; and the handler gated interrupt eligibility off the
  shell-thread snapshot while the UI used hydrated thread detail.
- Completed: updated mobile stop handling so it clears queued sends and uses
  hydrated thread detail to decide whether to dispatch `thread.turn.interrupt`.
- Completed: added focused regression coverage for the stop-decision logic.
- Completed: `bun run test src/features/threads/ThreadDetailScreen.test.ts`
  passes from `apps/mobile`, confirming the mobile Vitest harness works in
  this worktree.
- Completed: `bun run test src/state/use-selected-thread-commands.test.ts`
  passes from `apps/mobile` with 3 assertions covering the fixed stop path.
- Completed: `bun fmt` passed.
- Blocked: `bun lint` fails in this branch/worktree because the local
  `oxlint-plugin-t3code` plugin cannot resolve package `effect` when loaded by
  `oxlint`.
- Blocked: `bun typecheck` fails before reaching this patch because
  `apps/marketing` cannot find `astro`, and a direct mobile `tsc` run surfaces
  many broader branch typing issues unrelated to the stop-button change.

## Current Task: Rebase Mobile Track Onto Upstream 399b13dc7

Rebase the fork `feature/mobile-track` branch onto upstream
`t3code/mobile-remote-connect` commit
`399b13dc7 Refine mobile environment connection flows`, reconcile conflicts
with the fork mobile overlay, push the updated branch, and verify the mobile
EAS workflow.

### Current User Requirements

- Bring the upstream mobile branch update into our fork branch.
- Preserve the fork's mobile EAS/app identity setup and debugging overlay where
  still needed.
- Prefer upstream behavior and avoid unnecessary fork divergence.
- Do not disturb unrelated dirty files in other worktrees.
- Push the rebased branch and verify the GitHub mobile update workflow.

### Acceptance Criteria

- The working branch rebases successfully onto
  `upstream/t3code/mobile-remote-connect` at `399b13dc7`.
- Conflicts in mobile environment/catalog state are manually reconciled.
- Focused mobile checks, plus repo-required format/lint/typecheck where
  feasible, pass or have concrete blockers documented.
- `origin/feature/mobile-track` is updated with `--force-with-lease`.
- The triggered `Mobile Track EAS Update` GitHub run succeeds or failure details
  are reported.

### Status

- Completed: requirements captured before rebase/conflict edits.
- Completed: rebased the fork overlay onto upstream
  `399b13dc7 Refine mobile environment connection flows`.
- Completed: reconciled the mobile environment/catalog conflicts by keeping
  upstream's cached shell snapshot and connection timeout behavior while
  reapplying fork mobile diagnostics.
- Completed: local verification run:
  - `bun fmt`
  - `bun install --frozen-lockfile`
  - `bun run --filter @t3tools/mobile test src/state/shell-snapshot-refresh.test.ts`
  - `bun run --filter @t3tools/client-runtime test src/threadDetailState.test.ts`
  - `bun run --filter @t3tools/mobile test src/features/debug/mobileDebugCommands.test.ts src/lib/mobileDiagnostics.test.ts src/features/connection/pairing.test.ts`
  - `bun run --filter @t3tools/mobile typecheck`
  - `bun typecheck`
  - `NODE_OPTIONS=--experimental-strip-types bun lint`
- Note: plain `bun lint` remains blocked locally by Node's TypeScript plugin
  loader (`Unknown file extension ".ts"` for
  `oxlint-plugin-t3code/index.ts`); the strip-types lint run passed with
  warnings only.

## Current Task: Integrate Mobile Snapshot Fix Into GitHub CI/CD

Commit and push the rebased mobile snapshot fix through the existing
`feature/mobile-track` GitHub workflow so it is verified and published as an
iOS development EAS update.

### Current User Requirements

- Integrate the mobile snapshot fix into the mobile CI/CD path through GitHub.
- Use the existing mobile-track workflow where possible.
- Preserve unrelated local dirty files and do not include them in the commit.
- Verify the GitHub mobile workflow run after pushing.

### Acceptance Criteria

- The snapshot fix is committed on `feature/mobile-track`.
- The GitHub `Mobile Track EAS Update` workflow includes regression coverage
  for the new mobile snapshot refresh behavior.
- The rebased branch is pushed to `origin/feature/mobile-track`.
- The triggered GitHub workflow succeeds and publishes the development EAS
  update, or any failure is reported with concrete run details.

### Status

- Completed: confirmed `.github/workflows/mobile-track-eas-update.yml`
  triggers on pushes to `feature/mobile-track` touching `apps/mobile/**` and
  publishes an iOS development EAS update.
- Completed: added `Focused mobile snapshot regression` to the mobile GitHub
  workflow:
  `bun run --filter @t3tools/mobile test src/state/shell-snapshot-refresh.test.ts`.
- Completed: committed and force-with-lease pushed
  `6a119e0fd fix(mobile): wait for created thread snapshot` to
  `origin/feature/mobile-track`.
- Completed: GitHub `Mobile Track EAS Update` run `25778208337` succeeded in
  5m40s on the pushed mobile snapshot fix, including format, lint, typecheck,
  focused mobile snapshot regression, focused client-runtime regression, Expo
  token check, and `Publish EAS update`.
- Note: the workflow completed with existing lint annotations only; no errors
  blocked publication.

## Current Task: Rebase Mobile Track And Minimize Snapshot Fix Overlay

Rebase `feature/mobile-track` onto the latest
`upstream/t3code/mobile-remote-connect`, then remediate the mobile-created
thread “current mobile snapshot” routing failure while keeping the fork overlay
as small and upstream-aligned as possible.

### Current User Requirements

- Rebase against the most up-to-date upstream mobile branch before adding the
  fix.
- Favor upstream architecture wherever possible.
- Minimize the number and size of fork-local changes placed on top of upstream.
- After the rebase, provide a short summary of what the feature branch adds on
  top of upstream.
- Then proceed from the rebased branch to fix the mobile-created thread
  snapshot/catalog issue.
- Preserve existing user/worktree changes that are unrelated to this task.

### Acceptance Criteria

- `feature/mobile-track` is rebased onto the latest
  `upstream/t3code/mobile-remote-connect`.
- Existing local dirty changes are preserved and not accidentally overwritten.
- Fork overlay changes after rebase are summarized clearly.
- The remediation plan is revised against the rebased code before
  implementation.
- Required checks are run before declaring implementation complete, or any
  blockers are reported with concrete errors.

### Status

- Completed: requirements captured before rebase or implementation changes.
- Completed: preserved pre-existing dirty worktree changes in a named stash
  before rebasing, then restored them after the rebase.
- Completed: cleanly rebased `feature/mobile-track` onto
  `upstream/t3code/mobile-remote-connect` at
  `61b8aaa864a1e58c9d66a9ba2b48e3e0db75a7b9`.
- Completed: after rebase the fork overlay is 19 commits on top of upstream,
  covering fork mobile identity/build config, EAS update/scheduled rebase
  workflows, iPhone debug instrumentation, remote connection hardening,
  thread-detail subscription handling, clarification-form scroll behavior, and
  branch-specific docs.
- Completed: revised the remediation against the rebased code and kept it
  mobile-only by reusing upstream's existing `subscribeShell` stream as a
  one-shot fresh shell snapshot source.
- Completed: added a post-create shell refresh that waits for the newly
  created thread to appear before mobile navigates to the thread route.
- Completed: if the refreshed shell snapshot still does not contain the
  created thread, mobile now stays out of the known-bad route and surfaces a
  targeted connection error instead of rendering "Thread unavailable".
- Completed: added focused regression coverage for immediate shell refresh,
  retrying after an initially stale snapshot, and the final "not visible yet"
  result.
- Completed: validation run:
  - `bun run --filter @t3tools/mobile test src/state/shell-snapshot-refresh.test.ts`
  - `bun run --filter @t3tools/mobile typecheck`
  - `bun fmt`
  - `bun run --filter @t3tools/mobile test`
  - `NODE_OPTIONS=--experimental-strip-types bun lint:mobile`
  - `NODE_OPTIONS=--experimental-strip-types bun lint` (passed with existing
    warnings only)
  - `bun typecheck`
- Note: plain `bun lint:mobile` and `bun lint` are still blocked locally by
  Node 22.15.1 loading repo TypeScript entrypoints without
  `--experimental-strip-types`; the strip-types variants passed.

## Current Task: Scheduled Clean Mobile Rebase

Add automation so the fork can periodically check whether
`feature/mobile-track` is behind `upstream/t3code/mobile-remote-connect` and
automatically rebase/publish only when there is nothing requiring human review.

### Current User Requirements

- It makes sense to run remote build/upstream status checks on a GitHub
  schedule.
- If the mobile branch is out of date and the rebase is clean, automatically
  update it.
- If the rebase requires a decision or conflict review, do not guess; surface
  the failure for manual review.
- Preserve the existing policy of minimizing fork overlay changes and checking
  with the user when upstream supersedes fork changes.

### Acceptance Criteria

- A scheduled/manual GitHub workflow can detect whether `feature/mobile-track`
  is behind `upstream/t3code/mobile-remote-connect`.
- The workflow attempts an automatic rebase only when upstream has new commits.
- Clean rebases are verified and pushed, then an EAS update is published.
- Conflicted rebases fail without pushing partial state and produce actionable
  conflict output.
- Documentation notes that scheduled workflows must live on the default branch
  to run on GitHub.

### Status

- Completed: added `.github/workflows/mobile-track-sync.yml` to check upstream
  drift on a schedule/manual dispatch, rebase only when clean, run
  mobile-track verification, push with `--force-with-lease`, and publish an EAS
  update.
- Completed: documented that scheduled GitHub workflows must live on default
  branch `main` even though this workflow operates on `feature/mobile-track`.
- Completed: validation run:
  - YAML parsed successfully with Ruby `YAML.load_file`.
  - `bun fmt`
  - `bun lint` (passed with pre-existing warnings only)
  - `bun typecheck`
- In progress: committing the workflow and applying it to `main` so GitHub
  schedule events will run it.

## Current Task: Rebase Mobile Track Onto Latest Upstream

Rebase the fork `feature/mobile-track` branch onto the latest upstream
`upstream/t3code/mobile-remote-connect` commit and verify/push a fresh EAS
update.

### Current User Requirements

- Rebase `feature/mobile-track` onto the latest upstream mobile branch.
- Prefer as few fork changes as possible relative to upstream.
- Preserve fork functionality where still needed, including the mobile
  clarification-form scroll fix and fork EAS/mobile configuration.
- If upstream appears to supersede a fork change, stop and review before
  keeping the fork change.
- Push the updated branch and verify the remote mobile EAS update workflow.

### Acceptance Criteria

- `feature/mobile-track` is based on current
  `upstream/t3code/mobile-remote-connect`.
- Fork overlay commits are preserved or deliberately reconciled.
- Mobile clarification forms remain scrollable/interactable.
- Required local checks pass, or blockers are reported with concrete errors.
- GitHub `Mobile Track EAS Update` succeeds after push.

### Status

- Completed: rebased onto upstream
  `168ec8a81 Harden remote connect and subscription handling`.
- Completed: resolved the `apps/mobile/app.config.ts` conflict by keeping
  upstream's development-only cleartext behavior while re-applying the fork
  `fork.config.json` identity/EAS override hook.
- Completed: preserved the mobile clarification form scroll fix and focused
  regression coverage.
- Completed: local verification run:
  - `bun install --frozen-lockfile`
  - `bun run --filter @t3tools/mobile test src/features/threads/ThreadDetailScreen.test.ts`
  - `bun run --filter @t3tools/mobile test`
  - `bun run --filter @t3tools/mobile typecheck`
  - `bun scripts/mobile-native-static-check.ts`
  - `bun fmt`
  - `bun lint:mobile`
  - `bun lint`
  - `bun typecheck`
- Completed: pushed the rebased branch to `origin/feature/mobile-track` and
  verified GitHub `Mobile Track EAS Update` run `25687890264` succeeded on
  commit `37c495f41d078913edbbaaeb09ca00542b3eda07`, including EAS publish.

## Current Task: Fix Mobile Clarification Form Scroll Lock

Investigate and fix the mobile thread UI bug where plan/clarification question
content prevents the user from scrolling back up and interacting with the
rendered form, leaving the thread blocked.

### Current User Requirements

- Diagnose the UI bug on the mobile-track branch.
- Fix the thread plan / clarification question experience so the user can
  scroll and fill out the form.
- Unblock threads that currently get stuck because the clarification UI cannot
  be interacted with.
- Verify the relevant behavior with focused checks, then run the repo-required
  formatting, lint, and typecheck commands before finishing.

### Acceptance Criteria

- The clarification / plan question UI can be scrolled and interacted with on
  mobile.
- The fix preserves the existing thread detail UX outside of the broken
  interaction.
- Focused verification covers the affected UI logic.
- `bun fmt`, `bun lint`, and `bun typecheck` pass before completion, or any
  blocker is reported explicitly.

### Status

- Completed: identified the broken layout in
  `apps/mobile/src/features/threads/ThreadDetailScreen.tsx`, where the pending
  approval / clarification stack was rendered in a bottom-fixed
  `KeyboardStickyView` without its own scroll container or max height.
- Completed: wrapped the pending request stack in a bounded vertical
  `ScrollView` so long clarification forms stay reachable above the composer.
- Completed: extracted the pending-request height calculation into
  `apps/mobile/src/features/threads/threadDetailLayout.ts` and added focused
  regression coverage in
  `apps/mobile/src/features/threads/ThreadDetailScreen.test.ts`.
- Completed: verification run:
  - `bun run --filter @t3tools/mobile test src/features/threads/ThreadDetailScreen.test.ts`
  - `bun fmt`
  - `bun lint` (passed with pre-existing warnings only)
  - `bun typecheck`

## Current Task: Rebase Mobile Track Onto Upstream Mobile

Update the fork iOS/mobile feature branch by replaying Brad's mobile overlay
commits onto the latest upstream `t3code/mobile-remote-connect` branch.

### Current User Requirements

- Treat this as the T3 Code iOS app work, not the desktop/headless release
  branch.
- Use the fork's existing mobile branch and instructions.
- Rebase the fork overlay commits onto the current upstream mobile feature
  branch.
- Preserve fork/mobile documentation, EAS update setup, and local-only
  troubleshooting notes where still applicable.
- Run relevant mobile checks and push the updated branch when complete.

### Acceptance Criteria

- The rebased branch is based on current `upstream/t3code/mobile-remote-connect`.
- Fork-only mobile overlay commits are preserved or deliberately reconciled.
- Mobile app configuration and EAS update workflow remain present.
- Relevant checks pass, or blockers are reported with concrete errors.
- The updated feature branch is pushed to GitHub.

### Status

- Completed: created isolated worktree
  `.worktrees/mobile-track-rebased` from `origin/feature/mobile-track`.
- Completed: rebased the fork overlay commits onto
  `upstream/t3code/mobile-remote-connect` at
  `4ec9647ce799162a455dd7f59c4c6644358755df`.
- Completed: preserved the fork mobile app config, EAS update workflow, debug
  instrumentation, and thread-detail subscription fix.
- Completed: resolved the upstream git-to-VCS rename conflict in
  `apps/mobile/src/features/threads/ThreadRouteScreen.tsx`.
- Completed: verification run:
  - `bun install --frozen-lockfile`
  - `bun --filter @t3tools/mobile test`
  - `bun --filter @t3tools/mobile typecheck`
  - `bun scripts/mobile-native-static-check.ts`
  - `bun fmt`
  - `NODE_OPTIONS=--experimental-strip-types bun lint` (0 errors; existing
    warnings remain)
  - `bun typecheck`
- Note: plain `bun lint` and `bun lint:mobile` are blocked locally because this
  machine's default Node is v22.15.1 and cannot load the repo's `.ts` lint
  entrypoints without `--experimental-strip-types` or Bun.

## Current Task: Close Mobile Track Work

Update the mobile troubleshooting runbook with any lessons from the EAS
dev-client/debugging session, then commit outstanding work, merge the mobile
track branch to fork `main`, push to GitHub, and clean up the local
`feature/mobile-track` branch/worktree.

### Current User Requirements

- If the troubleshooting session produced reusable lessons, update the
  troubleshooting runbook.
- Commit all outstanding mobile-track work.
- Merge the completed mobile-track branch into fork `main`.
- Push the result to the user's GitHub fork.
- Clean up the local feature branch and worktree after the merge/push is
  complete.
- Continue to avoid committing or printing secrets.

### Acceptance Criteria

- `docs/mobile-ios-debugging.md` documents the EAS/dev-client troubleshooting
  behavior learned during the session.
- Required checks are run before finalizing.
- The relevant changes are committed and pushed.
- Fork `main` contains the merged mobile-track work.
- The local `feature/mobile-track` worktree and branch are removed after merge.

### Status

- Completed: updated `docs/mobile-ios-debugging.md` with stale EAS update
  troubleshooting, correct Expo dev-client deep-link launch form, and
  uninstall/reinstall verification notes.
- Completed: required checks passed:
  - `bun fmt`
  - `bun lint` (0 errors; existing warnings remain)
  - `bun typecheck` (passed; existing Effect advisory messages remain)
- In progress: committing and merging to fork `main`.

## Current Task: Automate Mobile EAS Updates

Add CI/CD so pushes to `feature/mobile-track` can publish the fork mobile app's
JavaScript/assets through EAS Update, making GitHub branch changes available to
installed compatible dev-client builds without manually running the update
command.

### Current User Requirements

- Add EAS Update publishing as part of CI for the mobile-track branch.
- Keep automation scoped to `feature/mobile-track`; do not affect fork `main`
  desktop sync/release workflows.
- Continue to avoid committing or printing secrets.
- Preserve existing mobile-track overlay rules and documentation.

### Acceptance Criteria

- A GitHub Actions workflow exists for `feature/mobile-track` pushes and manual
  dispatch.
- The workflow verifies the branch before publishing.
- The workflow publishes an EAS Update to the fork mobile app's development
  channel when the required Expo token secret is available.
- Repo docs explain what the workflow does and which secret it requires.
- Workflow syntax and relevant checks are verified locally where feasible.

### Status

- Completed: added `.github/workflows/mobile-track-eas-update.yml` for
  `feature/mobile-track` pushes and manual dispatch.
- Completed: documented the GitHub `EXPO_TOKEN` repository secret requirement
  in `LLM_INSTRUCTIONS.md` and `docs/mobile-ios-debugging.md`.
- Completed: local verification run:
  - parsed workflow YAML with Ruby
  - `bun fmt`
  - `bun lint` (0 errors; existing warnings remain)
  - `bun typecheck` (passed; existing Effect advisory messages remain)
- Note: `actionlint` is not installed locally, so GitHub-expression validation
  is deferred to the pushed workflow run.
- Completed: pushed workflow commits and verified GitHub Actions trigger.
- Completed: first hosted-runner workflow run validated install, format, lint,
  typecheck, and focused regression successfully.
- Blocked: EAS publish did not run because the GitHub repository secret
  `EXPO_TOKEN` is not configured. `gh secret list --repo jimprince/t3code`
  showed no `EXPO_TOKEN` entry.

## Current Task: Reconcile Mobile Spinner Debug Worktree

Reconcile the intentional work from
`/Users/brad/.t3/worktrees/t3-plugin/feature-ios-thread-spinner-debug` into the
canonical `feature/mobile-track` worktree, then remove the redundant spinner
debug branch/worktree once the useful changes are represented here.

### Current User Requirements

- Use `feature/mobile-track` as the canonical branch/worktree.
- Port the intentional iOS thread-opening spinner fix, diagnostics, tests,
  debug workflow improvements, and required docs/dependency changes from
  `feature/ios-thread-spinner-debug`.
- Do not keep generated or formatting-only drift unless it is needed for the
  intended reconciliation.
- Clean up the redundant spinner debug branch and worktree after reconciliation.
- Preserve unrelated existing mobile-track work.
- Do not print or commit secrets.

### Acceptance Criteria

- `feature/mobile-track` contains the useful spinner-debug changes.
- Low-signal generated-only diffs in the mobile-track worktree are removed.
- The spinner debug worktree and branch are removed after reconciliation.
- Focused verification is run where feasible, and any skipped repo-required
  verification is called out.

### Status

- Completed: ported the selected spinner-debug files into `feature/mobile-track`.
- Completed: removed generated/formatting-only drift from
  `apps/mobile/uniwind-types.d.ts` and `apps/web/public/mockServiceWorker.js`.
- Completed: verification run:
  - `bun fmt`
  - `bun lint` (0 errors; existing warnings remain)
  - `bun run --filter @t3tools/client-runtime test src/threadDetailState.test.ts`
  - `bun install` to refresh workspace dependencies after the first typecheck
    failed to resolve workspace packages
  - `bun typecheck` (passed after install; existing Effect advisory messages
    remain)
- Completed: removed redundant worktree
  `/Users/brad/.t3/worktrees/t3-plugin/feature-ios-thread-spinner-debug`.
- Completed: deleted local branch `feature/ios-thread-spinner-debug`.

## Current Task: Mobile Track Branch (feature/mobile-track)

Set up and maintain a long-lived fork branch that mirrors upstream's
`t3code/mobile-remote-connect` work (Expo + Uniwind + libghostty native mobile
app at `apps/mobile/`) and accepts the user's own commits on top, so future
upstream commits can be brought in by rebase without losing fork-local changes.

This branch is intentionally separate from fork `main`. `main` continues to
follow upstream stable/nightly desktop releases via `sync-upstream.yml`; this
branch tracks the upstream mobile feature branch instead.

### Current User Requirements

- Track `upstream/t3code/mobile-remote-connect` on a long-lived fork branch.
- Do NOT merge mobile work into fork `main` (do not disturb the
  `sync-upstream.yml` rebase model that runs on `main`).
- Allow the user to put their own commits on top of upstream mobile commits and
  have those replayed on each upstream sync.
- The user must be able to build the mobile app from the CLI.
- The user's Apple Developer Team (`CBCQ6MJF4B`) must be configured for iOS
  builds, paralleling the `t3code-ios` shell project.
- EAS iOS development build credentials must be configured for the fork dev
  bundle ID `com.brad.t3code.dev`; local Xcode signing in
  `/Users/brad/Programming/t3code-ios` is separate and does not satisfy EAS
  cloud build signing.
- Do not commit or print secrets (Apple ID password, App Store Connect API
  keys, EAS-managed credentials, provisioning profile contents).

### Constraints

- First project write for this task is this tracker (per repo `CORE_MANDATES`).
- Do not touch the user's WIP on `fix/checkpoint-revert-session-fallback` in
  the main checkout.
- Do not change `sync-upstream.yml`, `release.yml`, `fork-interim-release.yml`,
  or any other workflow that runs on `main`. Mobile-track is its own branch.
- Keep overlay commits small, surgical, and additive where possible to
  minimize rebase conflicts when new upstream mobile commits arrive.
- Any fork-specific identity (bundle ID, team ID, scheme) must avoid colliding
  with upstream's `com.t3tools.t3code*` namespace because Apple requires a
  unique bundle ID per developer.

### Current Acceptance Criteria

- Branch `feature/mobile-track` exists on `origin` (`jimprince/t3code`),
  rooted at `upstream/t3code/mobile-remote-connect`.
- Branch contains a small, well-named overlay of fork-local commits on top of
  the upstream mobile branch.
- Overlay includes:
  - This tracker.
  - A top-level `LLM_INSTRUCTIONS.md` describing how to bring new upstream
    mobile commits forward and how the overlay is organized.
  - `apps/mobile/fork.config.json` carrying non-secret fork identity (Apple
    team, bundle-id suffix, scheme suffix).
  - `apps/mobile/Makefile` with CLI helper targets that parallel
    `t3code-ios`'s Makefile (build/install/launch on the connected iPhone via
    Expo + EAS).
  - Minimal, surgical patches to `apps/mobile/app.config.ts` and
    `apps/mobile/eas.json` so fork identity is read from `fork.config.json`
    when present and upstream's `ascAppId` is not used by the fork.
- Re-running `git rebase upstream/t3code/mobile-remote-connect` after
  `git fetch upstream` brings in new upstream commits and replays the overlay
  cleanly when there are no semantic conflicts.
- The mobile app's iOS bundle identifier and Apple development team are
  configurable from `fork.config.json` without further code edits.
- The mobile app's EAS owner, project ID, and Expo Updates URL must resolve to
  the user's fork Expo project so OTA updates do not come from upstream.
- EAS build/update state must be verifiable from the CLI:
  - `eas build:list --platform ios --limit 5 --json` shows at least one iOS
    development build for `@jimprince/t3-code` after credentials are configured.
  - The latest relevant build uses profile `development` and bundle ID
    `com.brad.t3code.dev`.
  - EAS Updates remain on the fork project/channel (`development`) with runtime
    version `0.1.0`.
- Implement iOS pairing troubleshooting instrumentation for the fork mobile app:
  - Structured mobile diagnostics with secret redaction and app-document snapshots.
  - Root-level development/fork-only debug URL commands for pair, dump, clear,
    and disconnect.
  - A machine-readable mobile debug snapshot that distinguishes saved
    connection, runtime, shell snapshot, and catalog states.
  - Fork/dev scheme pairing URL extraction support.
  - Terminal metadata subscription failures must be diagnostic-only and must not
    prevent shell snapshot readiness.
  - Host-side iOS debug control script plus Make targets for VM pairing,
    dumping, clearing, and logs.
- Document the iOS debugging workflow and fork-overlay policy so future agents
  can reproduce the phone pairing test and know when to keep, rebase, or drop
  fork-only instrumentation.
- Surface the iOS debugging workflow from the branch entry instructions so it
  is immediately discoverable by future agents working on mobile pairing or
  physical-device testing.
- Installed-app debug verification must show `bundleIdentifier =
com.brad.t3code.dev`.
- `make ios-debug-vm-pair` must succeed against VM environment
  `c9d5fd19-15d1-45f1-856d-3d05a939854d` when Metro and the dev client are
  available.
- The phone should also be able to save and connect to this MacBook backend via
  the Mac's Tailscale URL `http://100.64.0.2:3773` without replacing the VM
  backend.
- Older/local backends that do not implement `subscribeTerminalMetadata` must
  still reach shell snapshot readiness; terminal metadata remains optional.

### Current Status

- Completed: fork Expo project wiring, EAS Updates on the `development`
  channel, mobile pairing diagnostics, host-side debug control tooling, and VM
  state dump verification.
- Completed: EAS cloud iOS signing credentials are configured for
  `com.brad.t3code.dev` under Apple team `CBCQ6MJF4B`.
- Completed: EAS development iOS dev-client build
  `545e2a20-54e7-47ec-9ed6-ecc70e89e47f` finished successfully and was
  installed on the connected iPhone as `com.brad.t3code.dev`.
- Completed: branch was rebased onto `upstream/t3code/mobile-remote-connect`
  at `0385713da`; the old duplicate hide-whitespace add/revert commits were
  skipped because upstream now contains that change.
- Completed: latest development EAS Update group is
  `bfc4eb11-f72b-499e-bebb-145f519c21de` for runtime `0.1.0`.
- Completed: `make ios-debug-vm-pair` passed against VM environment
  `c9d5fd19-15d1-45f1-856d-3d05a939854d`; runtime state was `ready`, shell
  snapshot loaded, with 7 projects and 14 threads at verification time.
- Note: the installed development client did not apply OTA updates when launched
  as a plain app during this run (`updateId` remained null). Physical-device
  verification used the Expo dev-client Metro path, which served the rebased
  JS/contracts directly.
- Completed: local MacBook backend was paired on the phone using Tailscale URL
  `http://100.64.0.2:3773` without replacing the VM backend. Debug dump showed
  both VM and Mac runtimes in `ready` state with shell snapshots loaded; Mac
  environment `5fa7c701-bf4d-496f-b753-55f77b4de905` had 11 projects and 161
  threads at verification time.
- Completed: mobile now sequences terminal metadata subscription after shell
  bootstrap so older/local backends that do not support `subscribeTerminalMetadata`
  still reach shell snapshot readiness.
- Completed: published the MacBook/Tailscale shell-bootstrap fix to EAS
  development channel with message
  `mobile mac tailscale shell bootstrap 476cffc7d`.

### Open Questions / Deferred

- Whether to add a fork CI workflow (`.github/workflows/mobile-track.yml`) for
  this branch. Deferred until the user wants automated mobile builds; the
  manual rebase + local CLI build flow is documented for now.
- Whether ongoing tracking should be automated via GitHub Actions on the fork
  (a `sync-upstream-mobile.yml` analogue of the existing desktop sync) or
  remain manual. Deferred — the manual rebase command is documented in the
  branch's `LLM_INSTRUCTIONS.md`. Promote to automation if the manual cadence
  becomes a burden.
