# Agent Requirements

## Active Requirements

- Troubleshoot why a new thread cannot be created in a project just created from a local folder.
- Account for the case where the project had no git repo initially and Git was initialized from the UI afterward.
- Implement a fix if the failure is in the repo.
- Commit the fix and push it to GitHub.
- Follow the GitHub macOS build after pushing.

## Constraints

- Follow repo instructions: `bun fmt`, `bun lint`, and `bun typecheck` must pass before completion.
- Do not run `bun test`; use `bun run test` for Vitest.
- Keep changes scoped to the new-thread/worktree failure path.

## Acceptance Criteria

- A project with an initialized but unborn git branch does not try to create a worktree from an invalid `main` ref.
- New thread send can proceed from the current checkout when there is no valid worktree base ref.
- Focused regression tests cover the fallback.
- The fix commit is pushed to the intended GitHub branch.
- The macOS GitHub Actions build is identified and monitored to completion or a clear blocker.

## Open Questions / Proposed Changes

- None.

## Status

- In progress: implementation complete; commit/push and macOS build follow-up pending.

## Verification

- Passed: `bun --filter @t3tools/web test src/components/ChatView.logic.test.ts`.
- Passed: `bun --filter @t3tools/web test -- --config vitest.browser.config.ts src/components/ChatView.browser.tsx -t "falls back to current checkout"`.
- Passed: `bun fmt`.
- Passed: `bun lint` with 9 pre-existing warnings and 0 errors.
- Passed: `bun typecheck`.

## User-Approved Requirement Changes

- None.
