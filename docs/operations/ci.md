# CI quality gates

- `.github/workflows/ci.yml` installs dependencies, validates fork stack/docs
  policy, and runs lint/format and Knip, workspace typechecks, web/server tests,
  desktop/headless build verification, mobile native static analysis, and
  release smokes on pull requests and pushes to `main` or immutable
  `ci-candidate/<sha>` branches.
- The Linux Build job runs historical startup and restart against the built
  server bundle, then builds the release-format Linux x64 headless tarball and
  smokes its installed executable with no Node on PATH. Both use disposable
  homes and historical fixture databases; no provider or live state is needed.
  Headless packaging uses the checked-in package version without rewriting
  manifests, reuses the desktop pipeline's web/server output, and stores the
  archive in runner temp. The job allows 30 minutes for SEA and Rust builds.
  Candidate evidence reuse requires both smoke steps to have succeeded; missing
  or skipped smoke evidence forces normal verification. Release builds still
  verify their own version-stamped artifacts.
- `.github/workflows/release.yml` publishes the fork release artifacts from
  release tags: macOS arm64 desktop DMG/zip/updater manifest plus the Linux x64
  headless tarball.
- `.github/workflows/mobile-eas-development.yml` is a manual-only legacy
  iOS development lane for Brad's EAS project. It uses Expo fingerprinting to
  avoid publishing updates to incompatible native runtimes; normal production
  App Store/TestFlight delivery is also manual-only. CI never contacts Apple: new iOS development
  builds consume the signing credentials already stored on EAS, and credential
  refreshes are done manually via an interactive local `eas build` (see
  [Release Workflow](./release.md#legacy-mobile-eas-development-lane-manual-only)).
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
  migration added after the last stable release), so scheduled runs select nightly only. The daily schedule is 09:17 UTC.
- The external CI Repair Bot is the repairer. It should claim an eligible
  handoff within 20 minutes, check out the exact leased `main` and canonical
  StGit metadata, and obtain ordered policy from
  `scripts/ci/prepare-stgit-publication --format=json`, capturing publication
  leases before replay. A repair operates inside the
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

Clean automatic replays pass `scripts/ci/verify-stgit-replay` before main or a
release tag changes. The gate stages an exact candidate and waits for the normal
GitHub CI workflow, including all workspace typechecks and tests. Main CI reuses
that successful source run while checking the published stack; release preflight
follows the evidence to its actual run attempt. See the
[candidate verification contract](./fork-maintenance.md#one-candidate-verification-contract).
All writers publish through `publish-stgit-stack`, using preparation-time main
and metadata leases and immutable snapshots in the same transaction. A gate
failure leaves the published stack intact; subsequent release preflight protects
the stamped build as a separate check.
