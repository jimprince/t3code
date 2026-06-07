# LLM_INSTRUCTIONS

Fork-specific knowledge that is **not derivable** from the code or git history.
Future agents working in this repo: read this before touching versioning,
releases, or the sync pipeline.

This repo (`jimprince/t3code`) is a fork of [`pingdotgg/t3code`](https://github.com/pingdotgg/t3code).
The general agent guide is in `CLAUDE.md` / `AGENTS.md`; this file covers only
things specific to the fork relationship.

## Fast path for release/update work

1. Optionally start the local macOS runner before a release that needs desktop
   macOS artifacts:

   ```bash
   t3code-mac-runner start 7200
   ```

   Release preflight prefers this runner when it is online and idle. If it is
   unavailable or busy, the macOS build falls back to GitHub-hosted `macos-15`.
   GitHub Actions cannot migrate a job that is already queued on a
   self-hosted label, so this choice happens before the build job is created.

2. Normal upstream sync:

   ```bash
   gh workflow run sync-upstream.yml --repo jimprince/t3code -f channel=stable
   gh workflow run sync-upstream.yml --repo jimprince/t3code -f channel=nightly
   ```

   Before testing an existing nightly or headless server update, discover the
   current fork release state rather than reusing an old tag:

   ```bash
   gh release list --repo jimprince/t3code --limit 10
   ```

3. Reroll the same upstream nightly for updater testing by dispatching
   `release.yml` with the next explicit `-fork.N` version. The dispatch form
   only offers `channel=stable`; the version string still makes the run nightly.

   ```bash
   gh workflow run release.yml --repo jimprince/t3code \
     -f channel=stable \
     -f version=v0.0.22-nightly.20260423.108-fork.2
   ```

   Add `target_ref` only when the workflow should build a specific existing
   tag or commit instead of the workflow ref, for example recovering an
   existing tag whose release publication failed:

   ```bash
   gh workflow run release.yml --repo jimprince/t3code \
     --ref main \
     -f channel=stable \
     -f version=v0.0.22-nightly.20260427.135-fork.1 \
     -f target_ref=v0.0.22-nightly.20260427.135-fork.1
   ```

4. Watch and verify:

   ```bash
   gh run watch <run-id> --repo jimprince/t3code --exit-status
   gh release view <tag> --repo jimprince/t3code --json tagName,isPrerelease,publishedAt,url,assets
   curl -fsSL https://github.com/jimprince/t3code/releases/download/<tag>/nightly-mac.yml | sed -n '1,80p'
   tail -n 160 ~/.t3/userdata/logs/desktop-main.log | rg -i 'desktop-updater|Update available|Ignoring|No updates'
   ```

   When Brad asks for "remote build status", "build status", or whether the
   fork build succeeded, report the active fork deliverable lanes separately:
   mac Electron app and Linux/headless app. Both come from the main-branch
   `Release` workflow (`release.yml`) and its published GitHub release assets.
   The old `feature/mobile-track` drift workflow was retired after upstream
   deleted `t3code/mobile-remote-connect`. Mobile EAS updates are now a
   main-based lane: inspect `Mobile EAS Development Update` separately from the
   desktop/headless fork release result. The development lane uses Expo
   fingerprinting, so a native runtime change should start or select a matching
   iOS development build instead of publishing an incompatible OTA update. The
   iOS build step also needs the existing `APPLE_API_KEY`, `APPLE_API_KEY_ID`,
   and `APPLE_API_ISSUER` secrets so EAS can refresh ad hoc provisioning
   profiles for both the app target and the widget extension target in
   non-interactive CI. Internal iOS EAS profiles must keep
   `enterpriseProvisioning: "adhoc"` to avoid a CI prompt for Apple team type.

5. Stop the runner when done:

   ```bash
   t3code-mac-runner stop
   ```

Validated updater path: an installed
`v0.0.22-nightly.20260423.108-fork.1` app detected
`v0.0.22-nightly.20260423.108-fork.2` through the nightly mac updater feed.

## The fork-mirroring model

Our version numbers **mirror upstream**. Our release tags are derived from
upstream release tags + fork commits rebased on top. There is no independent
versioning axis for the fork.

- `.github/workflows/sync-upstream.yml` runs every 3 hours and creates release
  tags when upstream ships on the selected channel. Do not manually bump the
  version in `package.json` or invent release numbers.
- Normal pushes to `main` that affect packaged app/runtime output run
  `.github/workflows/fork-push-nightly.yml`, which publishes the fork
  changes through the nightly feed. The workflow rebases fork commits onto the
  latest upstream nightly tag, stamps package versions, and tags the result as
  `${upstream_nightly_tag}-fork.N`. These pushes do **not** create stable/latest
  `vNEXT-fork.N` releases. The next upstream stable sync rebases the fork
  commits onto the upstream stable tag and publishes the integrated stable
  release.
- sync-upstream fetches upstream tags into `refs/tags/upstream/*` (namespaced)
  to avoid clobbering our tags, then rebases our fork commits onto the upstream
  tag, stamps releasable package versions to the fork release version, and
  force-pushes `main` plus a release tag that points at the stamped commit.
  Pushing the release tag is what drives the build: `release.yml` has no
  `schedule:` trigger and fires only on tag pushes (and `workflow_dispatch`).
  Rebase conflict auto-resolution is intentionally asymmetric: package version
  files resolve to upstream and are re-stamped later, while
  `.github/workflows/release.yml` resolves to the fork side because this fork's
  release matrix and runner fallback are deliberately custom.
- Tag scheme by channel:
  - **stable**: `${upstream_tag}` verbatim (e.g. `v0.0.21`). The fork and
    upstream share the tag name; the commit on the fork is upstream's commit
    plus our rebased fork commits.
  - **nightly**: `${upstream_tag}-fork.${N}`
    (e.g. `v0.0.21-nightly.20260421.88-fork.1`), where `N` auto-increments
    per upstream nightly tag. The `-fork.N` suffix:
    1. distinguishes our artifact from upstream's,
    2. sorts strictly higher than the bare upstream tag under semver
       (alphanumeric `88-fork` > numeric `88`), so electron-updater sees
       each successive fork rebuild as an upgrade,
    3. lets a manual reroll on the same upstream commit publish as an upgrade
       when you dispatch `release.yml` with the next explicit `-fork.N`.
       Fork nightly tags must contain the upstream nightly tag commit as an
       ancestor. `sync-upstream.yml` intentionally skips only when an existing
       fork tag for that upstream nightly has that ancestry; malformed tags do
       not block a corrected sync. Use manual release dispatch for intentional
       same-upstream rerolls.
- Workflows require `GH_PAT` in secrets for tag/commit pushes that need to
  trigger follow-on workflows or modify workflow files. Release creation uses
  `GH_PAT` when present, with the workflow-scoped `GITHUB_TOKEN` as fallback;
  this avoids GitHub's intermittent `Resource not accessible by integration`
  failure during release creation.
- Release publish/finalize jobs use `vp install --ignore-scripts` because they
  only need helper scripts and artifact upload. Nightly preflight and Linux
  build installs also use `--ignore-scripts` so native dependency lifecycle
  hangs do not block macOS updater releases. Keep full dependency lifecycle
  scripts for stable preflight/build jobs.

If you need to put fork patches on top of upstream, push normal commits to
`main`. The next sync rebases them forward automatically.

### Channel: stable and nightly

Scheduled `sync-upstream` runs check **both** upstream stable releases
(`/releases/latest`, excludes pre-releases) and upstream nightly pre-releases
(first release whose tag matches `v<ver>-nightly.*` or
`nightly-v<ver>-nightly.*`). Manual runs can target one channel, or select
`both` to check both.

**One-off run for a channel:**

```bash
gh workflow run sync-upstream.yml --repo jimprince/t3code -f channel=stable
gh workflow run sync-upstream.yml --repo jimprince/t3code -f channel=nightly
```

**One-off run for both channels:**

```bash
gh workflow run sync-upstream.yml --repo jimprince/t3code -f channel=both
```

There is no persistent channel variable anymore. If you see a stale
`SYNC_CHANNEL` repo variable, it is ignored by the workflow and can be deleted.

**Tradeoffs of tracking nightlies:**

- Upstream ships 2–3 nightlies/day; our sync runs every 3h, so at most ~1 lag.
- More frequent rebases = more chances for conflicts with our fork commits.
  On conflict, the workflow fails with resolution instructions (see lines
  106–121 of the workflow). Our previous nightly stays in place until resolved
  — no data loss.
- `main` gets force-pushed on every sync. Any local work on `main` needs
  `git pull --rebase`; long-running feature branches should branch off and
  rebase when ready.
- No GitHub billing concern: `jimprince/t3code` is public, so Actions minutes
  are unlimited and free.

**Nightly release concurrency:** all nightly tag pushes share the
`release-nightly` concurrency group with `cancel-in-progress: true` in
`release.yml`. When several upstream nightlies arrive close together (e.g. the
local mac runner was offline and the queue grew), only the newest one ships;
older queued/in-progress nightly builds get cancelled. Stable tags
(`v0.0.21`, `v0.0.22-fork.N`) and manual `workflow_dispatch` runs keep
per-run groups and always complete.

## Build matrix is intentionally minimal

`.github/workflows/release.yml` only builds:

- macOS arm64 Electron app (dmg + zip)
- Linux x64 headless server tarball

We deliberately **dropped** Linux Electron/AppImage, Windows x64, Windows
arm64, and macOS x64. They added flake surface without being used. Do not
"helpfully" re-add them.

Remote build status in this fork is a three-part answer:

1. mac Electron app: the `Release` workflow's macOS arm64 matrix leg succeeded
   and published the mac updater manifest plus dmg/zip assets.
2. Linux/headless app: the `Release` workflow's Linux x64 matrix leg succeeded
   and published `t3-headless-<version>-linux-x64.tar.gz`.
3. Mobile app: the `Mobile EAS Development Update` workflow on `main`
   succeeded and either published an iOS EAS update to the `jimprince`
   development channel or started a matching iOS development build when the
   native fingerprint changed. The iOS development build includes the widget
   extension target, so CI uses the existing App Store Connect API key secrets
   to refresh ad hoc provisioning profiles when starting a new build. Internal
   iOS profiles use `enterpriseProvisioning: "adhoc"` so EAS does not prompt
   for Apple team type in CI. Mobile is not built by `release.yml`; it is
   deployed by
   `.github/workflows/mobile-eas-development.yml` when mobile/runtime paths
   change or when manually dispatched. Bad development OTA updates can be
   recovered with
   `.github/workflows/mobile-eas-development-rollback.yml`.

- macOS arm64 prefers the local self-hosted `t3code-mac-arm64` runner when it
  is online and idle. If it is offline or busy during preflight, the workflow
  uses GitHub-hosted `macos-15` instead. GitHub Actions cannot migrate an
  already queued self-hosted job, so this fallback decision must happen before
  the build job is created.
- `fail_on_unmatched_files: false` on the `softprops/action-gh-release@v2` step
  is intentional — it lets the publish step succeed when patterns for dropped
  platforms don't match.
- The Linux release artifact is the headless server tarball, not an Electron
  AppImage and not part of the desktop updater flow. It is required before
  publishing both stable and nightly releases. It is named
  `t3-headless-<version>-linux-x64.tar.gz`, includes `bin/t3`,
  `apps/server/dist/bin.mjs`, `apps/server/dist/client/**`, and staged
  production `node_modules`, and its CI job smoke-tests `--version`, `--help`,
  and HTTP startup from a clean unpack. Target hosts need Node.js 22.16+.
- Headless hosts should update with the external
  `scripts/headless-auto-upgrade.sh` flow documented in `docs/release.md`, not
  an in-process self-updater. The updater stages a versioned release directory,
  atomically flips `current`, restarts `t3code.service`, health-checks the
  server version, and rolls back on failure. This keeps a 24/7 server safe:
  clients only see the intentional restart window, and the running process is
  never overwritten in place. The systemd timer checks once per day, and newer
  clients can request an immediate check through the authenticated
  `server.requestHeadlessUpdateCheck` RPC when a Linux server reports an older
  version. That RPC must start the existing user systemd upgrade service; do
  not run the updater as an in-process child of the server being restarted.
- The 2-attempt retry wrapper around `vp run dist:desktop:artifact` absorbs
  transient flakes (macOS `hdiutil: Device not configured`, native-dep network
  hiccups). Don't remove it.

## App identity: "Fork", not "Alpha"

Upstream's `productName` is `"T3 Code (Alpha)"`. Installing our fork over that
silently replaced upstream's installation. We renamed the packaged app to
`"T3 Code (Fork)"` across all externally visible surfaces:

- `apps/desktop/package.json` `productName` (drives `.app` bundle, dmg title,
  macOS menu bar, `CFBundleName`).
- `DesktopAppStageLabel` union in `packages/contracts/src/ipc.ts` — upstream's
  values were `"Alpha" | "Dev" | "Nightly"`; ours are `"Dev" | "Fork" | "Nightly"`.
  `"Alpha"` is intentionally absent. If you add it back you'll reintroduce the
  upstream collision.
- `apps/desktop/src/app/DesktopEnvironment.ts` resolves stable packaged
  builds to `"Fork"` and dev-flavor packaged builds to `"Fork Dev"`.
- Desktop environment consumers use `"T3 Code (Fork)"` for window titles,
  user-data dir, Windows app model IDs, Linux desktop entries, and updater
  identity.
- `apps/web/src/branding.ts` has `"Fork"` as the non-Electron fallback.
- `apps/web/index.html` `<title>` is `"T3 Code (Fork)"`.

When merging upstream changes that touch any of these, keep our values.

## macOS signing and notarization

macOS release artifacts are Developer ID-signed and notarized when the release
job has all required Apple secrets:

- `CSC_LINK`
- `CSC_KEY_PASSWORD`
- `APPLE_API_KEY`
- `APPLE_API_KEY_ID`
- `APPLE_API_ISSUER`

`.github/workflows/release.yml` writes the App Store Connect key to a temporary
`.p8` file, exports `APPLE_API_KEY` as that file path, and passes `--signed` to
`scripts/build-desktop-artifact.ts`. The build script leaves Electron Builder's
signing/notarization environment intact only for signed builds; unsigned builds
strip the Apple signing variables and disable certificate auto-discovery.

Before assuming a macOS release is Gatekeeper-ready, verify the build log
contains both `macOS signing enabled.` and `notarization successful`. You may
check secret names with `gh secret list --repo jimprince/t3code`, but never
print or inspect secret values. The latest verified signed/notarized fork
release at the time this note was updated was
`v0.0.23-nightly.20260506.212-fork.1`.

The Linux headless tarball is not code-signed. Windows signing setup is
intentionally omitted because Windows is not part of the fork release matrix.

## Fork-only interim builds: use `-fork.N` pre-release suffix

If you need to ship a fork-only patch _before_ upstream releases the next
version (rebrand, fork-specific bugfix, config change), **do not** claim a
real version number like `v0.0.21`. That poisons sync-upstream: when upstream
eventually releases that number, sync sees we already have the tag and
silently skips, permanently losing upstream's changes for that version.

The correct pattern is a semver pre-release suffix targeting the **next
unreleased upstream patch version**:

```
v0.0.22-fork.1    ← first interim fork build
v0.0.22-fork.2    ← next interim fork build
v0.0.22-fork.3    ← ...and so on
```

Why this works:

- **Auto-update sees it as an upgrade**: `0.0.22-fork.1 > 0.0.21` because
  patch 22 > patch 21. Fork-only stable builds are published as normal GitHub
  releases, not prereleases, so stable desktop clients can see them.
- **Upstream's eventual release wins**: `0.0.22 > 0.0.22-fork.N` because a
  pre-release suffix sorts _lower_ than the release itself in semver. When
  upstream ships `v0.0.22`, sync creates it cleanly; users auto-update off
  the fork build.
- **sync-upstream is not blocked**: the tag `v0.0.22-fork.N` is a different
  string from `v0.0.22`, so `git rev-parse --verify v0.0.22` still fails and
  sync proceeds when upstream catches up.

### How to ship a fork build

1. Figure out the **next unreleased upstream patch version**:

   ```bash
   gh api repos/pingdotgg/t3code/releases/latest --jq .tag_name
   ```

   If upstream is at `v0.0.20`, your target base is `0.0.21`. If our own main
   already has fork-tags at that base (check `git tag --list 'v*-fork.*'`),
   just bump `N`.

2. Dispatch release.yml with an explicit version input:

   ```bash
   gh workflow run release.yml --repo jimprince/t3code \
     -f channel=stable -f version=v0.0.21-fork.1
   ```

### Never pre-claim a real version number

We did this once (shipped `v0.0.21` pre-emptively before upstream); we deleted
the tag + release to unblock sync-upstream. Don't repeat that. Fork-only
builds always use `-fork.N`.

`sync-upstream.yml` now checks tag ancestry, not only tag existence: an existing
fork tag must contain upstream's `refs/tags/vX` as an ancestor before it counts
as already synced. The `-fork.N` convention still avoids pre-claiming the exact
future upstream stable tag name.

## Fork-only stable auto-releases

`.github/workflows/fork-interim-release.yml` watches a narrow allowlist of
paths that can affect packaged app/runtime output (`apps/**`, `packages/**`,
`assets/**`, root package/build files, and desktop artifact build inputs).
Docs, workflows, and unrelated helper scripts must not publish a fork-only
desktop update. If the pushed commit is not already release-tagged and is not
the release finalizer's `chore(release): prepare ...` commit, it computes the
next unreleased upstream patch version, stamps releasable package versions to
that release version, commits the stamp, and pushes `vNEXT-fork.N` at the
stamped commit.

Example: if upstream latest stable is `v0.0.21`, the first fork-only main
push creates `v0.0.22-fork.1`; the next creates `v0.0.22-fork.2`. These are
published as normal latest releases so stable desktop clients see them. When
upstream later ships `v0.0.22`, sync-upstream publishes `v0.0.22`, which
semver ranks above every `v0.0.22-fork.N`.

Release tags must contain the stamped package versions, not only rely on
`release.yml`'s temporary build-time stamp. The headless `t3` CLI reports its
version from `apps/server/package.json`, and remote/headless installs may run
from a tag checkout rather than a desktop release artifact.

## Worktree pattern for commits

The user often has WIP in the main working tree. When committing fork
maintenance (workflows, branding, docs) that shouldn't touch their WIP, use a
detached worktree:

```bash
git fetch origin main
git worktree add /tmp/t3code-<task> origin/main
cd /tmp/t3code-<task>
git checkout -b <task-branch>
# ...edit, test, commit...
git push origin <task-branch>:main
cd -
git worktree remove /tmp/t3code-<task>
```

This keeps the user's dirty files in `/Users/brad/Programming/t3-plugin`
untouched.
