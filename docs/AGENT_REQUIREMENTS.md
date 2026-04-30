# Agent Requirements

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

### Current Status

- In progress: initial branch setup + overlay scaffolding.
- Out of scope for this task: actually running `bun install` /
  `expo prebuild` / a real device install. The user wanted the branch
  scaffolded so they can drive the build from there. Build verification will
  follow as a separate task.

### Open Questions / Deferred

- Whether to add a fork CI workflow (`.github/workflows/mobile-track.yml`) for
  this branch. Deferred until the user wants automated mobile builds; the
  manual rebase + local CLI build flow is documented for now.
- Whether ongoing tracking should be automated via GitHub Actions on the fork
  (a `sync-upstream-mobile.yml` analogue of the existing desktop sync) or
  remain manual. Deferred — the manual rebase command is documented in the
  branch's `LLM_INSTRUCTIONS.md`. Promote to automation if the manual cadence
  becomes a burden.
