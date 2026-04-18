# Agent Requirements

## Active Requirements

- Work in `/Users/brad/Programming/t3-plugin`.
- Ship a fork-only desktop release so the updater path can be tested end-to-end.
- Use a semver prerelease fork version instead of a real upstream version number.
- Keep changes minimal and inspectable.
- Verify the released version metadata and updater artifacts are suitable for testing updates.

## Constraints

- Follow repo-local instructions from `LLM_INSTRUCTIONS.md` and `AGENTS.md`.
- All of `bun fmt`, `bun lint`, and `bun typecheck` must pass before calling the task complete.
- Never run `bun test`; use `bun run test` or focused `bun run vitest ...` commands.
- Preserve existing fork-specific packaging/runtime identity behavior unless a minimal fix is required.
- Do not pre-claim a real upstream tag; use the documented `-fork.N` convention.
- Current repo state is already dirty; avoid unrelated edits and account for pre-existing local changes when preparing the release.

## Acceptance Criteria

- The chosen release version is a fork prerelease tag compatible with the repo workflow (expected base: `v0.0.21-fork.N` unless inspection shows otherwise).
- Any code needed so the built app reports the correct release version is updated minimally.
- Relevant docs remain consistent with the fork release/update behavior.
- Required verification commands are run and reported.
- The GitHub release workflow is dispatched for the fork version and its result is checked.
- The resulting release/update artifacts are verified enough to proceed with updater testing.

## Open Questions / Proposed Changes

- The working tree already contains local release-related modifications in `apps/desktop`, `scripts/`, `package.json`, and `docs/`. Confirm whether those changes are exactly what should ship for the fork release or whether any subset must be excluded.
- Determine the next available fork prerelease tag from local/remote tags before dispatching the release.

## Status

- In progress

## Verification

- Pending
