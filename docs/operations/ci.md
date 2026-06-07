# CI quality gates

- `.github/workflows/ci.yml` runs Vite+ install, `vp check`,
  `vp run typecheck`, desktop build verification, repo tests, browser tests,
  mobile native static analysis, and release-smoke checks on pull requests and
  pushes to `main`.
- `.github/workflows/release.yml` publishes the fork release artifacts from
  release tags: macOS arm64 desktop DMG/zip/updater manifest plus the Linux x64
  headless tarball.
- `.github/workflows/mobile-eas-development.yml` publishes iOS EAS development
  updates for Brad's EAS project from relevant `main` pushes or manual dispatch.
- `.github/workflows/mobile-eas-preview.yml` handles PR preview mobile
  builds/updates with Expo fingerprinting.
- See [Release Workflow](./release.md) for the full fork release and mobile
  EAS model.
