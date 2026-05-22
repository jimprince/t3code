# Agent Requirements

## Active Requirements

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

## Constraints

- Follow repo instructions: `bun fmt`, `bun lint`, and `bun typecheck` must pass before completion.
- Do not run `bun test`; use `bun run test` for Vitest.
- Keep the new-thread fix scoped to the new-thread/worktree failure path.
- Keep release workflow changes scoped to the push-triggered fork build path,
  release docs, and agent-facing release instructions.

## Acceptance Criteria

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

## Open Questions / Proposed Changes

- None.

## Status

- Complete: thread fix is pushed; release build completed; push-triggered fork
  builds now publish through the nightly channel and remain integrated into the
  next upstream stable sync.

## Verification

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

## User-Approved Requirement Changes

- None.
