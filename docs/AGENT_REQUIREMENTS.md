# Agent Requirements

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

## Constraints

- Do not overwrite unrelated user work.
- Avoid destructive remote cleanup unless it is directly part of repairing the broken release state.
- Use GitHub CLI/API wrappers; do not read or expose secrets.
- For GitHub release creation, prefer the workflow-scoped `GITHUB_TOKEN` with
  `contents: write` when it works; if GitHub rejects release creation with
  `Resource not accessible by integration`, use the existing release-capable
  `GH_PAT` secret without printing or inspecting it.

## Status

- Implemented: release workflow routes macOS arm64 jobs to the local self-hosted runner label while Linux remains hosted.
- Implemented: local runner script supports on-demand detached `tmux` start, status, stop, and foreground run modes with a default 2-hour TTL.
- Implemented: shared `github-actions-local-runner` skill documents Brad's no-startup-service, TTL-limited local runner preference.
- Operational state: release run `24874392764` completed successfully and
  published `v0.0.21` at `2026-04-24T06:00:35Z`; finalizer pushed
  `chore(release): prepare v0.0.21`.
- Implemented: release publishing now uses the job-scoped `GITHUB_TOKEN` for
  `softprops/action-gh-release`; `GH_PAT` remains reserved for tag/commit pushes.
- Implemented: orphan latest-nightly tag entries were removed from the GitHub
  Releases Atom feed.
- Implemented: nightly release `v0.0.22-nightly.20260423.108-fork.1` was
  recreated through the fixed sync/release path and published successfully at
  `2026-04-24T07:36:10Z` with `nightly-mac.yml`, macOS DMG/zip/blockmaps, and
  Linux AppImage assets.
- Implemented: nightly Linux builds and publish/finalize jobs avoid dependency
  lifecycle-script hangs in the paths that can otherwise block macOS updater
  publication.
