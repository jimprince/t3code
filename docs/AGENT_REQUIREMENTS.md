# Agent Requirements

## Active Requirements

- Work in `/Users/brad/Programming/t3-plugin`.
- Base the fork work on current `upstream/main`.
- Integrate only the Codex-side `T3_THREAD_ID` environment injection.
- Do not carry forward the OpenCode fork changes.
- Keep changes minimal and inspectable.

## Constraints

- Follow repo-local instructions from `LLM_INSTRUCTIONS.md` and `CLAUDE.md`.
- Limit implementation to the Codex app-server spawn path and focused test coverage.
- Leave the repo in a clean state and report the resulting branch/commit state.

## Acceptance Criteria

- Codex app-server spawn includes `T3_THREAD_ID=<threadId>`.
- A focused test covers the injected env.
- `bun fmt`, `bun lint`, `bun typecheck`, and the focused Vitest target pass.
- The resulting branch is based on `upstream/main` without the OpenCode fork stack.

## Open Questions / Proposed Changes

- A pre-rebase backup branch was created: `backup/main-before-upstream-rebase-20260415-2359`.

## Status

- In progress

## Verification

- `bun fmt` passed
- `bun lint` passed with pre-existing upstream warnings in unrelated `apps/web` files
- `bun typecheck` failed on current `upstream/main` in unrelated `packages/contracts` schema code
- `cd apps/server && bun run vitest run src/codexAppServerManager.test.ts` failed before test execution due an upstream runtime/schema issue unrelated to the Codex env patch
