# LLM_INSTRUCTIONS — `feature/mobile-track` branch

You are reading this on the **mobile-track** fork branch
(`feature/mobile-track`). This branch is **not** fork `main`; it has different
rules and a different upstream.

## What this branch is

- A long-lived fork branch that mirrors
  `upstream/t3code/mobile-remote-connect` (the upstream Expo + Uniwind +
  libghostty native mobile app at `apps/mobile/`).
- It carries a small **fork overlay** of commits at the tip — fork-local
  identity (Apple Team, bundle id), CLI build helpers, and these
  instructions.
- Each time we want new upstream mobile commits we **rebase the overlay**
  forward onto the latest `upstream/t3code/mobile-remote-connect`. Because
  the overlay is small and additive, conflicts should be rare and isolated.

If you're looking for fork desktop release/sync rules, branch back to
`origin/main` and read its `LLM_INSTRUCTIONS.md` instead. Those rules do
**not** apply here.

For general monorepo-wide rules (`bun fmt`, `bun lint`, `bun typecheck`,
project snapshot), read upstream's `AGENTS.md` at the repo root. This file
covers only what is fork-specific to `feature/mobile-track`.

## Active task

See `docs/AGENT_REQUIREMENTS.md` for the active mobile-track task,
constraints, acceptance criteria, and status. Treat it as required execution
metadata before changing files.

## Physical iPhone pairing/debug loop

If the task mentions iOS pairing, the phone, the dev VM, Tailscale backend
connectivity, "No threads yet", thread-open spinners, Expo dev-client updates,
or agent-driven mobile testing, read `docs/mobile-ios-debugging.md` before
changing code.

That doc explains the fork-local instrumentation and host workflow:

```bash
cd apps/mobile
APP_VARIANT=development CI=1 bunx expo start --dev-client --clear
make ios-debug-vm-pair
```

The workflow pairs the installed dev app to the desktop dev VM
(`http://100.64.0.4:3773`), copies a redacted app-state snapshot from the
iPhone, and verifies the shell snapshot reaches `ready`.

## How the overlay is organized

The overlay sits at the tip of `feature/mobile-track`. Roughly:

| Layer                                     | Purpose                                                                |
| ----------------------------------------- | ---------------------------------------------------------------------- |
| `docs/AGENT_REQUIREMENTS.md`              | Active fork task tracker (this branch).                                |
| `LLM_INSTRUCTIONS.md` (this file)         | How to work on this branch.                                            |
| `apps/mobile/fork.config.json`            | Non-secret fork identity: Apple team, bundle-id suffix, scheme suffix. |
| `apps/mobile/app.config.ts` (small patch) | Reads `fork.config.json` when present and overrides upstream defaults. |
| `apps/mobile/eas.json` (small patch)      | Drops upstream's `ascAppId` so the fork uses its own EAS config.       |
| `apps/mobile/Makefile`                    | CLI helpers paralleling `~/Programming/t3code-ios/Makefile`.           |

**Design rule:** keep overlay edits to existing upstream files _surgical_.
Anything bigger should live in a new fork-only file (like `fork.config.json`)
that upstream files _read from_. This minimizes rebase conflicts.

## Bringing in new upstream mobile commits (rebase tracking)

```bash
# from any worktree of this branch
git fetch upstream
git checkout feature/mobile-track
git rebase upstream/t3code/mobile-remote-connect
git push --force-with-lease origin feature/mobile-track
```

If the rebase conflicts:

1. Resolve each conflict to keep upstream's intent **plus** the fork overlay's
   intent. Most conflicts will be in `apps/mobile/app.config.ts` or
   `apps/mobile/eas.json` — re-apply the small fork patch on top of the new
   upstream version.
2. Continue with `git rebase --continue`.
3. If the fork overlay no longer makes sense after upstream changes, update
   `docs/AGENT_REQUIREMENTS.md` and adjust the overlay before re-pushing.

This is intentionally a manual command for now. Promote to a scheduled fork
workflow only if the cadence becomes a burden — see "Open Questions" in
`docs/AGENT_REQUIREMENTS.md`.

## Working on this branch (worktree pattern)

The user keeps WIP in `/Users/brad/Programming/t3-plugin` and on the fork
`main`. To avoid disturbing that, do mobile-track work in a dedicated
worktree:

```bash
git -C /Users/brad/Programming/t3-plugin fetch origin
git -C /Users/brad/Programming/t3-plugin worktree add \
  /Users/brad/Programming/t3-plugin/.worktrees/mobile-track \
  origin/feature/mobile-track
cd /Users/brad/Programming/t3-plugin/.worktrees/mobile-track
# ...build, edit, commit on feature/mobile-track...
git push origin feature/mobile-track
```

Remove the worktree when finished:

```bash
git -C /Users/brad/Programming/t3-plugin worktree remove \
  /Users/brad/Programming/t3-plugin/.worktrees/mobile-track
```

## Building the mobile app from the CLI

Mobile entry point lives at `apps/mobile/`. The fork CLI helpers parallel
`~/Programming/t3code-ios/Makefile`:

```bash
cd apps/mobile
make help                 # list targets
make ios-dev              # local dev-client iOS build via expo prebuild + run:ios
make eas-ios-dev          # cloud dev-client build via EAS (requires `eas login`)
make ios-debug-vm-pair    # physical iPhone pairing/debug smoke test
```

The Apple Team ID and fork bundle-id suffix are read from
`apps/mobile/fork.config.json`. EAS-managed credentials (Apple ID password,
ASC API keys, provisioning profiles) live in EAS and **must not** be added to
this repo.

For EAS signing, build, update, and physical-device verification status, read
`docs/mobile-ios-debugging.md`. Do not assume local Xcode provisioning from
`/Users/brad/Programming/t3code-ios` means EAS cloud credentials are configured
for this Expo app. Prefer `npx eas-cli` if `bunx eas-cli` hits transient package
resolution failures.

## Hard rules on this branch

- Do not modify any `.github/workflows/*.yml` that targets `main` (sync,
  release, fork-interim, etc). They run on `main`, not here.
- Do not pre-claim a fork release tag from this branch. Mobile-track is not
  released through the existing desktop release pipeline.
- Do not commit secrets — Apple credentials, ASC API keys, provisioning
  profiles, EAS tokens. Non-secret fork identity (`CBCQ6MJF4B`) goes in
  `fork.config.json`.
- Do not rename or remove `fork.config.json` — `app.config.ts` and
  `eas.json` patches read from it.

## When in doubt

1. Read `docs/AGENT_REQUIREMENTS.md` for the current task scope.
2. Read this file for the overlay/tracking model.
3. Check `apps/mobile/README.md` (upstream's mobile docs) for Expo build
   commands.
4. Cross-reference `~/Programming/t3code-ios/` for the WKWebView shell — it
   is **not** part of this monorepo and is independent of `apps/mobile/`.
