# Agent Requirements

## Current Task: Remote Upgrade Button for Disconnected Environments

Add an `Upgrade remote` action to the disconnected saved-environment banner
when T3 Code can infer that the remote Linux server is older than the current
client. The action must start an out-of-band upgrade when possible, then
reconnect the environment.

### Current User Requirements

- Show `Upgrade remote` on disconnected/error saved remote environments only
  when the last-known remote server version is older than the current client,
  the last-known platform is Linux, and an out-of-band path exists.
- Preserve the existing `Reconnect` primary action and `Connections` action.
- Use desktop SSH bootstrap/relaunch semantics for desktop-managed SSH
  environments.
- For non-SSH HTTP remotes, add an authenticated
  `POST /api/server/headless-update-check` endpoint that reuses the existing
  headless update requester and bearer-session authentication.
- Add a web HTTP helper for the remote headless update request.
- Add a confirmation dialog before starting the upgrade.
- On success, toast the result and attempt reconnect after a short delay.
- On failure, show a useful error and keep reconnect/connections available.
- Suppress duplicate generic version-skew banner text when the disconnected
  banner already includes the version mismatch.

### Constraints

- Do not depend only on the active environment WebSocket because the feature is
  exposed while disconnected.
- Keep Linux as the only supported remote upgrade target in this change.
- Do not add provider-update UI or provider-update contracts.
- Do not add live upgrade log streaming, Windows/macOS remote support, package
  manager UI, global channel changes, or forced upgrades when the client is not
  newer.
- Follow repo checks: `bun fmt`, `bun lint`, `bun typecheck`, and
  `bun run test`. Never run `bun test`.

### Acceptance Criteria

- A disconnected older Linux saved remote with desktop SSH shows
  `Upgrade remote`, confirms, starts the desktop SSH relaunch path, toasts, and
  attempts reconnect.
- A disconnected older Linux saved HTTP remote with a bearer token shows
  `Upgrade remote`, confirms, calls the authenticated HTTP update endpoint,
  handles queued/cooldown/unsupported/error statuses, and attempts reconnect on
  queued/cooldown success cases.
- Ineligible environments do not show the button.
- Existing reconnect behavior remains intact.
- Unit/integration coverage exercises eligibility, web remote API behavior, and
  the authenticated server endpoint.

### Status

- Completed.

### Verification

- Passed: added pure remote upgrade eligibility logic with unit coverage for
  local/primary, missing config, client-not-newer, non-Linux, connecting,
  desktop SSH, remote HTTP bearer-token, and no-out-of-band-path cases.
- Passed: added authenticated remote HTTP update request helper coverage for
  bearer auth, request body, and non-2xx error surfacing.
- Passed: added authenticated server endpoint coverage for unauthenticated
  rejection and bearer-authenticated headless update check requests.
- Passed: wired the disconnected banner to show `Upgrade remote`, include
  remote/client version copy, open a confirmation dialog, call the out-of-band
  upgrade service, toast results, and reconnect on queued/started/cooldown
  success paths.
- Passed: `bun fmt`.
- Passed: `bun lint` with 9 existing warnings and 0 errors.
- Passed: `bun typecheck`.
- Passed: `bun run test`.

### Open Questions / Proposed Changes

- None.

### User-Approved Requirement Changes

- None.

## Active Requirements

- Use the local Mac as an on-demand GitHub Actions build worker for T3 Code
  macOS arm64 builds to reduce remote build latency.
- Keep Linux/headless builds on GitHub-hosted runners unless explicitly changed.
- Route only trusted T3 Code release/fork build jobs to the self-hosted Mac
  runner label.
- Do not install the local runner as a permanent startup/login service unless
  explicitly requested.
- Ensure CI/release dependency setup installs the Electron binary before desktop
  tests or desktop artifact builds import Electron.
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
- Troubleshoot why OpenCode-backed threads lose model continuity after an idle
  gap or provider-session recovery.
- Persist and reuse the OpenCode provider session id so recovered turns continue
  the same OpenCode conversation instead of starting a blank session.
- Commit, merge, and push the OpenCode continuity fix.
- Ensure macOS release builds do not get stuck or fail when the local Mac runner
  is not online.
- Prefer the local Mac runner only when release preflight can confirm the
  `t3code-mac-arm64` runner is online and idle.
- Fall back to GitHub-hosted macOS infrastructure when the runner is offline,
  busy, or the workflow lacks permission to query self-hosted runner state.
- Persist the local Mac build-agent lessons in repo docs and shared
  agent-facing workflow notes so future agents can repeat the setup without
  rediscovering the same failure modes.

## Constraints

- Follow repo instructions: `bun fmt`, `bun lint`, and `bun typecheck` must pass before completion.
- Do not run `bun test`; use `bun run test` for Vitest.
- Keep the new-thread fix scoped to the new-thread/worktree failure path.
- Keep release workflow changes scoped to the push-triggered fork build path,
  release docs, and agent-facing release instructions.
- Keep the OpenCode continuity fix scoped to provider resume behavior and
  focused regression coverage.
- Keep the local Mac runner on-demand/time-limited and avoid exposing GitHub
  runner registration tokens in logs or chat.
- Do not require a self-hosted runner for normal releases when the local Mac is
  unavailable.
- Do not print or commit any GitHub runner/API token used for runner discovery.

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
- OpenCode-backed threads persist a `{ sessionId }` resume cursor.
- OpenCode recovery starts from the saved session id or, for older uncursored
  threads, an exact-title matching OpenCode session, rather than creating a
  blank session.
- T3 Code macOS arm64 release jobs prefer the local self-hosted runner label
  `t3code-mac-arm64` only after preflight confirms it is online and idle.
- The local runner can be started/stopped/status-checked using the existing
  `t3code-mac-runner` helper.
- Release preflight reaches macOS runner resolution instead of failing desktop
  tests because the Electron executable is missing.
- If the runner probe cannot confirm an online idle `t3code-mac-arm64` runner,
  `release.yml` resolves macOS arm64 builds to GitHub-hosted `macos-15`.
- If a suitable token is available and the runner is online/idle, `release.yml`
  resolves macOS arm64 builds to
  `["self-hosted","macOS","ARM64","t3code-mac-arm64"]`.
- Repo docs and the shared local-runner skill document the fallback behavior,
  optional runner-state token, and repeatable `t3code-mac-runner` workflow.

## Open Questions / Proposed Changes

- None.

## Status

- Complete: thread fix is pushed; release build completed; push-triggered fork
  builds now publish through the nightly channel and remain integrated into the
  next upstream stable sync.
- Complete: OpenCode continuity fix is implemented, verified, merged into
  `main`, and pushed.
- In progress: local Mac runner is online; CI/release Electron binary install is
  being committed so the release preflight can reach runner resolution.
- Complete: release preflight now falls back to GitHub-hosted `macos-15` when
  the local Mac runner is unavailable or runner-state probing is not authorized.
- Complete: reusable local Mac runner lessons are documented in `docs/release.md`,
  the shared `github-actions-local-runner` skill, and shared T3 Code memory.

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
- Confirmed from the live `state.sqlite` and provider log that
  `194f1cc3-0954-4d7d-be51-f5bc0fabe4a1` is an OpenCode thread whose
  `provider_session_runtime.resume_cursor_json` was `null`; the follow-up turn
  ran in a different OpenCode session id than the prior deployment turn.
- Passed: `bun --filter t3 test -- src/provider/Layers/OpenCodeAdapter.test.ts`.
- Passed: `bun fmt`.
- Passed: `bun lint` with 9 existing warnings and 0 errors.
- Passed: `bun typecheck`.
- Verified: Release run `26552666470` failed before runner resolution because
  Ubuntu preflight desktop tests could not resolve the Electron executable after
  dependency install.
- Verified: `t3code-mac-runner start 7200` started the local runner in detached
  `tmux`; GitHub reports `t3code-mac-macbookpro` online, idle, and labeled
  `t3code-mac-arm64`.
- Passed: `bun run install:electron`.
- Passed: `bun --filter '@t3tools/desktop' test`.
- Passed: `git diff --check`.
- Partial: `bun run test` passed through desktop and web packages locally, then
  the server Vitest process stopped producing output and was terminated.
- Verified: Release run `26553119701` passed the first explicit Electron install
  step but still failed desktop tests because the helper did not verify the
  executable was present.
- Added: `scripts/install-electron-binary.mjs` clears skip flags, runs Electron's
  installer, verifies the platform executable, and retries once after removing a
  stale `dist`/`path.txt`.
- Verified: CI run `26553321559` failed fast in `install:electron`; the verifier
  reported that Linux `dist/electron` was still missing, so the helper now pins
  Electron's installer to the current runner `npm_config_platform` and
  `npm_config_arch`.
- Updated: after CI run `26553427131` showed the pinned installer still produced
  only `dist/locales`, the helper now falls back to direct `@electron/get`
  download/extract and writes Electron's `path.txt` itself.
- Updated: release run `26553548478` hit Node's unsettled top-level-await exit
  path while using `@electron/get`; the fallback now uses synchronous `curl`
  plus `unzip` against Electron's published artifact URL.
- Verified: release run `26553695852` passed preflight through Electron install,
  lint, typecheck, and tests, but its runner API check returned HTTP 403 and
  fell back to GitHub-hosted `macos-15`. The workflow now routes macOS arm64
  directly to the `t3code-mac-arm64` self-hosted label.
- Verified: release run `26554025503` completed successfully for
  `v0.0.25-nightly.20260515.295-fork.8`; preflight passed, macOS arm64 built on
  the local `t3code-mac-macbookpro` runner in 7m24s, and the release published
  the notarized DMG/ZIP plus the headless Linux tarball.
- Passed: release workflow YAML parses with Ruby's YAML parser.
- Passed: extracted "Resolve macOS runner" shell passes `bash -n`.
- Passed: runner resolution simulation with no token emits `runner="macos-15"`.
- Passed: runner resolution simulation with an unauthorized token emits
  `runner="macos-15"`.
- Passed: runner resolution simulation with a fake online runner emits
  `runner=["self-hosted","macOS","ARM64","t3code-mac-arm64"]`.

## User-Approved Requirement Changes

- None.
