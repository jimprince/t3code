# Agent Requirements

## Current Task: Reconcile Mobile Spinner Debug Worktree

Reconcile the intentional work from
`/Users/brad/.t3/worktrees/t3-plugin/feature-ios-thread-spinner-debug` into the
canonical `feature/mobile-track` worktree, then remove the redundant spinner
debug branch/worktree once the useful changes are represented here.

### Current User Requirements

- Use `feature/mobile-track` as the canonical branch/worktree.
- Port the intentional iOS thread-opening spinner fix, diagnostics, tests,
  debug workflow improvements, and required docs/dependency changes from
  `feature/ios-thread-spinner-debug`.
- Do not keep generated or formatting-only drift unless it is needed for the
  intended reconciliation.
- Clean up the redundant spinner debug branch and worktree after reconciliation.
- Preserve unrelated existing mobile-track work.
- Do not print or commit secrets.

### Acceptance Criteria

- `feature/mobile-track` contains the useful spinner-debug changes.
- Low-signal generated-only diffs in the mobile-track worktree are removed.
- The spinner debug worktree and branch are removed after reconciliation.
- Focused verification is run where feasible, and any skipped repo-required
  verification is called out.

### Status

- Completed: ported the selected spinner-debug files into `feature/mobile-track`.
- Completed: removed generated/formatting-only drift from
  `apps/mobile/uniwind-types.d.ts` and `apps/web/public/mockServiceWorker.js`.
- Completed: verification run:
  - `bun fmt`
  - `bun lint` (0 errors; existing warnings remain)
  - `bun run --filter @t3tools/client-runtime test src/threadDetailState.test.ts`
  - `bun install` to refresh workspace dependencies after the first typecheck
    failed to resolve workspace packages
  - `bun typecheck` (passed after install; existing Effect advisory messages
    remain)
- Completed: removed redundant worktree
  `/Users/brad/.t3/worktrees/t3-plugin/feature-ios-thread-spinner-debug`.
- Completed: deleted local branch `feature/ios-thread-spinner-debug`.

## Current Task: Mobile Track Branch (feature/mobile-track)

Set up and maintain a long-lived fork branch that mirrors upstream's
`t3code/mobile-remote-connect` work (Expo + Uniwind + libghostty native mobile
app at `apps/mobile/`) and accepts the user's own commits on top, so future
upstream commits can be brought in by rebase without losing fork-local changes.

This branch is intentionally separate from fork `main`. `main` continues to
follow upstream stable/nightly desktop releases via `sync-upstream.yml`; this
branch tracks the upstream mobile feature branch instead.

### Current User Requirements

- Track `upstream/t3code/mobile-remote-connect` on a long-lived fork branch.
- Do NOT merge mobile work into fork `main` (do not disturb the
  `sync-upstream.yml` rebase model that runs on `main`).
- Allow the user to put their own commits on top of upstream mobile commits and
  have those replayed on each upstream sync.
- The user must be able to build the mobile app from the CLI.
- The user's Apple Developer Team (`CBCQ6MJF4B`) must be configured for iOS
  builds, paralleling the `t3code-ios` shell project.
- EAS iOS development build credentials must be configured for the fork dev
  bundle ID `com.brad.t3code.dev`; local Xcode signing in
  `/Users/brad/Programming/t3code-ios` is separate and does not satisfy EAS
  cloud build signing.
- Do not commit or print secrets (Apple ID password, App Store Connect API
  keys, EAS-managed credentials, provisioning profile contents).

### Constraints

- First project write for this task is this tracker (per repo `CORE_MANDATES`).
- Do not touch the user's WIP on `fix/checkpoint-revert-session-fallback` in
  the main checkout.
- Do not change `sync-upstream.yml`, `release.yml`, `fork-interim-release.yml`,
  or any other workflow that runs on `main`. Mobile-track is its own branch.
- Keep overlay commits small, surgical, and additive where possible to
  minimize rebase conflicts when new upstream mobile commits arrive.
- Any fork-specific identity (bundle ID, team ID, scheme) must avoid colliding
  with upstream's `com.t3tools.t3code*` namespace because Apple requires a
  unique bundle ID per developer.

### Current Acceptance Criteria

- Branch `feature/mobile-track` exists on `origin` (`jimprince/t3code`),
  rooted at `upstream/t3code/mobile-remote-connect`.
- Branch contains a small, well-named overlay of fork-local commits on top of
  the upstream mobile branch.
- Overlay includes:
  - This tracker.
  - A top-level `LLM_INSTRUCTIONS.md` describing how to bring new upstream
    mobile commits forward and how the overlay is organized.
  - `apps/mobile/fork.config.json` carrying non-secret fork identity (Apple
    team, bundle-id suffix, scheme suffix).
  - `apps/mobile/Makefile` with CLI helper targets that parallel
    `t3code-ios`'s Makefile (build/install/launch on the connected iPhone via
    Expo + EAS).
  - Minimal, surgical patches to `apps/mobile/app.config.ts` and
    `apps/mobile/eas.json` so fork identity is read from `fork.config.json`
    when present and upstream's `ascAppId` is not used by the fork.
- Re-running `git rebase upstream/t3code/mobile-remote-connect` after
  `git fetch upstream` brings in new upstream commits and replays the overlay
  cleanly when there are no semantic conflicts.
- The mobile app's iOS bundle identifier and Apple development team are
  configurable from `fork.config.json` without further code edits.
- The mobile app's EAS owner, project ID, and Expo Updates URL must resolve to
  the user's fork Expo project so OTA updates do not come from upstream.
- EAS build/update state must be verifiable from the CLI:
  - `eas build:list --platform ios --limit 5 --json` shows at least one iOS
    development build for `@jimprince/t3-code` after credentials are configured.
  - The latest relevant build uses profile `development` and bundle ID
    `com.brad.t3code.dev`.
  - EAS Updates remain on the fork project/channel (`development`) with runtime
    version `0.1.0`.
- Implement iOS pairing troubleshooting instrumentation for the fork mobile app:
  - Structured mobile diagnostics with secret redaction and app-document snapshots.
  - Root-level development/fork-only debug URL commands for pair, dump, clear,
    and disconnect.
  - A machine-readable mobile debug snapshot that distinguishes saved
    connection, runtime, shell snapshot, and catalog states.
  - Fork/dev scheme pairing URL extraction support.
  - Terminal metadata subscription failures must be diagnostic-only and must not
    prevent shell snapshot readiness.
  - Host-side iOS debug control script plus Make targets for VM pairing,
    dumping, clearing, and logs.
- Document the iOS debugging workflow and fork-overlay policy so future agents
  can reproduce the phone pairing test and know when to keep, rebase, or drop
  fork-only instrumentation.
- Surface the iOS debugging workflow from the branch entry instructions so it
  is immediately discoverable by future agents working on mobile pairing or
  physical-device testing.
- Installed-app debug verification must show `bundleIdentifier =
com.brad.t3code.dev`.
- `make ios-debug-vm-pair` must succeed against VM environment
  `c9d5fd19-15d1-45f1-856d-3d05a939854d` when Metro and the dev client are
  available.
- The phone should also be able to save and connect to this MacBook backend via
  the Mac's Tailscale URL `http://100.64.0.2:3773` without replacing the VM
  backend.
- Older/local backends that do not implement `subscribeTerminalMetadata` must
  still reach shell snapshot readiness; terminal metadata remains optional.

### Current Status

- Completed: fork Expo project wiring, EAS Updates on the `development`
  channel, mobile pairing diagnostics, host-side debug control tooling, and VM
  state dump verification.
- Completed: EAS cloud iOS signing credentials are configured for
  `com.brad.t3code.dev` under Apple team `CBCQ6MJF4B`.
- Completed: EAS development iOS dev-client build
  `545e2a20-54e7-47ec-9ed6-ecc70e89e47f` finished successfully and was
  installed on the connected iPhone as `com.brad.t3code.dev`.
- Completed: branch was rebased onto `upstream/t3code/mobile-remote-connect`
  at `0385713da`; the old duplicate hide-whitespace add/revert commits were
  skipped because upstream now contains that change.
- Completed: latest development EAS Update group is
  `bfc4eb11-f72b-499e-bebb-145f519c21de` for runtime `0.1.0`.
- Completed: `make ios-debug-vm-pair` passed against VM environment
  `c9d5fd19-15d1-45f1-856d-3d05a939854d`; runtime state was `ready`, shell
  snapshot loaded, with 7 projects and 14 threads at verification time.
- Note: the installed development client did not apply OTA updates when launched
  as a plain app during this run (`updateId` remained null). Physical-device
  verification used the Expo dev-client Metro path, which served the rebased
  JS/contracts directly.
- Completed: local MacBook backend was paired on the phone using Tailscale URL
  `http://100.64.0.2:3773` without replacing the VM backend. Debug dump showed
  both VM and Mac runtimes in `ready` state with shell snapshots loaded; Mac
  environment `5fa7c701-bf4d-496f-b753-55f77b4de905` had 11 projects and 161
  threads at verification time.
- Completed: mobile now sequences terminal metadata subscription after shell
  bootstrap so older/local backends that do not support `subscribeTerminalMetadata`
  still reach shell snapshot readiness.
- Completed: published the MacBook/Tailscale shell-bootstrap fix to EAS
  development channel with message
  `mobile mac tailscale shell bootstrap 476cffc7d`.

### Open Questions / Deferred

- Whether to add a fork CI workflow (`.github/workflows/mobile-track.yml`) for
  this branch. Deferred until the user wants automated mobile builds; the
  manual rebase + local CLI build flow is documented for now.
- Whether ongoing tracking should be automated via GitHub Actions on the fork
  (a `sync-upstream-mobile.yml` analogue of the existing desktop sync) or
  remain manual. Deferred — the manual rebase command is documented in the
  branch's `LLM_INSTRUCTIONS.md`. Promote to automation if the manual cadence
  becomes a burden.
