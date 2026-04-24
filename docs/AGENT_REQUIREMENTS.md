# Agent Requirements

## Active Requirements

Implement **Option A** for fork nightly releases so the fork can auto-update
off upstream nightlies with a clean tag-triggered pipeline.

Concretely:

1. `sync-upstream.yml` (nightly channel): after rebasing onto the upstream
   nightly tag, create and push a fork-specific tag of the form
   `${upstream_tag}-fork.${N}` (monotonically increasing `N` per upstream
   tag). Stable channel behavior is unchanged (push `${upstream_tag}`
   verbatim).
2. `release.yml`: accept fork-nightly tag pushes
   (`v*-nightly.*-fork.*`) via the `on.push.tags` trigger. Determine channel
   from the tag name (presence of `-nightly.` → nightly, otherwise stable).
3. `release.yml`: drop the `schedule:` trigger and the `check_changes` job so
   fork builds fire on actual upstream-driven tag pushes instead of a
   parallel cron. `workflow_dispatch` for ad-hoc nightly builds stays.

## Constraints

- Follow repo-local instructions in `LLM_INSTRUCTIONS.md` and `CLAUDE.md`.
- Build matrix stays minimal: macOS arm64 + Linux x64 only. Do not re-add
  Windows or macOS x64.
- Stable channel behavior must not regress: pushing `v0.0.21` still triggers
  a stable release; existing `-fork.N` interim convention for stable-channel
  fork-only patches (per `LLM_INSTRUCTIONS.md`) must still work.
- Keep all changes reviewable; prefer minimal edits over rewrites.
- Update `docs/release.md` and `LLM_INSTRUCTIONS.md` so they match the new
  pipeline.
- Do not push/commit without explicit user consent — present the diff first.

## Acceptance Criteria

- `sync-upstream.yml` in nightly mode pushes `<upstream>-fork.<N>` and
  increments `N` when re-run against the same upstream tag.
- `release.yml` tag filter includes fork nightly tags and excludes pure
  upstream nightly tags (so a leaked upstream tag wouldn't trigger a build).
- `release.yml` has no `schedule:` trigger and no `check_changes` job.
- `release.yml` nightly path on tag push derives version/tag/name from the
  pushed tag, not from `resolve-nightly-release.ts`.
- `workflow_dispatch` with `channel=nightly` (no version input) still works
  for manual nightly dispatch.
- `docs/release.md` accurately describes the 2-platform matrix and
  tag-driven nightly flow.
- `LLM_INSTRUCTIONS.md` documents the `-fork.N` nightly tag convention.
- `bun run test` for scripts stays green (resolve-nightly-release,
  update-release-package-versions, etc.).
- All three nightly-version parsers
  (`scripts/resolve-previous-release-tag.ts`,
  `apps/desktop/src/updateChannels.ts`,
  `scripts/build-desktop-artifact.ts`) accept the
  `-fork.N` suffix. Fork nightlies must route to the `nightly` updater
  channel at both build time and install time.

## Open Questions / Proposed Changes

- Semver of fork nightly tag (`v0.0.21-nightly.20260421.88-fork.1`) has
  `88-fork` as one pre-release identifier (hyphens are legal inside
  identifiers). Alphanumeric identifier sorts higher than the numeric `88`,
  which makes the fork version strictly greater than the upstream nightly
  under semver ordering — required for electron-updater upgrade detection.
- Channel detection is tag-name-based: presence of `-nightly.` anywhere in
  the pre-release → nightly. Pure `vX.Y.Z` or `vX.Y.Z-fork.N` → stable.

## Status

- Completed.

## Verification Notes

- **YAML**: `python3 -c "import yaml; yaml.safe_load(open('.github/workflows/release.yml'))"`
  and sync-upstream.yml both parse cleanly.
- **Scripts tests** (`cd scripts && bun run vitest run`): 54/54 pass across 7
  files, including the new fork-nightly cases in
  `build-desktop-artifact.test.ts`.
- **Desktop tests** (`cd apps/desktop && bun run vitest run`): 95/95 pass
  across 16 files, including the new fork-nightly cases in
  `updateChannels.test.ts`.
- **Break-the-fix regression check** (per CORE_MANDATES): reverted the regex
  in both `updateChannels.ts` and `build-desktop-artifact.ts` and confirmed
  the new fork-nightly tests fail with the exact "expected 'nightly' …
  received 'latest'" signal. Restored the fix; tests green again.
- **awk `-fork.N` increment logic** (verified via Python equivalent):
  empty → 1; `[1,2,3]` → 4; `[5]` → 6; out-of-order `[1,10,2,3]` sorted
  numerically → 11. Safe on bash 5 (ubuntu-24.04), which `mapfile` requires.
- **parseNightlyTag + compareNightlyVersions sanity check** (inline bun -e):
  `no-fork < fork.1 < fork.2`, required for electron-updater to pick up
  each successive fork rebuild.
- **Third parser site caught mid-session**: `scripts/build-desktop-artifact.ts`
  `resolveDesktopUpdateChannel` had the same anchored `\d+$` regex and would
  have misrouted fork-nightly packaging to the `latest` channel (wrong
  icons + wrong updater manifest filename). Found via a broader `-nightly`
  grep; fix + regression tests added.
- **Full `bun run test` at repo root**: 12/13 workspaces green. The one
  failing workspace (`apps/server` → `CheckpointReactor.test.ts`) fails on
  orchestration-event timing assertions unrelated to this change (zero
  grep hits for nightly/fork/version in that file); failures reproduce
  both before and after my edits.
- **End-to-end verification** is still deferred to user-driven
  `gh workflow run sync-upstream.yml -f channel=nightly` after merge.
