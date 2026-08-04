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
  selected upstream tag. The repository-owned
  `scripts/ci/reproduce-sync-upstream` driver is shared with the CI repair bot;
  a repair operates inside the failing patch and refreshes that patch instead
  of appending a commit. The inventory and metadata checks derive the live
  series dynamically. Patch count may grow when an authorized independent
  concern is added.
- The fork policy CI job checks both the StGit stack and the documentation
  discovery graph. Publishing keeps the rendered `main`, stack metadata, and
  canonical patch refs together; obsolete patch refs are deleted with exact
  leases in the same atomic transaction.
- See [Release Workflow](./release.md) for the full fork release and mobile
  EAS model.
