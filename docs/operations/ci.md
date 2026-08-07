# CI quality gates

- `.github/workflows/ci.yml` runs Vite+ install, `vp check`,
  `vp run typecheck`, desktop build verification, repo tests, browser tests,
  mobile native static analysis, and release-smoke checks on pull requests and
  pushes to `main`.
- `.github/workflows/release.yml` publishes the fork release artifacts from
  release tags: macOS arm64 desktop DMG/zip/updater manifest plus the Linux x64
  headless tarball.
- `.github/workflows/mobile-eas-development.yml` deploys the iOS development
  EAS lane for Brad's EAS project from relevant `main` pushes or manual
  dispatch, using Expo fingerprinting to avoid publishing updates to
  incompatible native runtimes. CI never contacts Apple: new iOS development
  builds consume the signing credentials already stored on EAS, and credential
  refreshes are done manually via an interactive local `eas build` (see
  [Release Workflow](./release.md), "Mobile EAS Development Lane").
- `.github/workflows/mobile-eas-development-rollback.yml` manually rolls a bad
  iOS development runtime back to the embedded bundle.
- `.github/workflows/mobile-eas-preview.yml` handles PR preview mobile
  builds/updates with Expo fingerprinting.
- `.github/workflows/sync-upstream.yml` replays the ordered StGit series on each
  selected upstream tag. The workflow is the detector: on conflict it fails
  normally and emits a versioned machine-readable handoff in both its log and
  job summary, including eligibility, target, channel, failing patch and
  files, and the required stack-context contract. Stable and nightly are
  independent matrix channels, so a nightly conflict does not invalidate a
  stable result. The fork ships the nightly feed, so scheduled runs sync
  nightly only and stable runs solely on an explicit `channel=stable`
  dispatch: a stable replay conflicts by construction whenever the stack sits
  on a nightly base referencing upstream files the stable tag lacks (such as a
  migration added after the last stable release), and letting that fail every
  three hours left this workflow permanently red for the channel that ships.
- The external CI Repair Bot is the repairer. It should claim an eligible
  handoff within 20 minutes, check out the exact leased `main` and canonical
  StGit metadata, and obtain ordered policy from
  `scripts/ci/check-stgit-stack --format=json`. A repair operates inside the
  failing patch and refreshes that patch instead of appending a commit. Patch
  count may grow for an authorized independent concern, but a rebase repair
  must preserve the ordered names and subjects exactly.
- The repair service preflights autonomy whenever remote `main` or its stack
  ref changes and before processing an incident. Its `status.json` reports
  readiness, check time, remote object IDs, contract, and the precise error.
  An incompatible checkout becomes `needs_attention` before an agent is
  launched or an attempt is consumed. A live poller is degraded when an
  eligible failure remains unclaimed beyond the 15-minute poll interval plus
  five minutes of grace; readiness notifications are deduplicated while other
  workflows continue polling.
- The fork policy CI job checks both the StGit stack and the documentation
  discovery graph. Publishing keeps the rendered `main`, stack metadata, and
  canonical patch refs together; obsolete patch refs are deleted with exact
  leases in the same atomic transaction.
- See [Release Workflow](./release.md) for the full fork release and mobile
  EAS model.
