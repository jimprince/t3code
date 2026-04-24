# LLM_INSTRUCTIONS

Fork-specific knowledge that is **not derivable** from the code or git history.
Future agents working in this repo: read this before touching versioning,
releases, or the sync pipeline.

This repo (`jimprince/t3code`) is a fork of [`pingdotgg/t3code`](https://github.com/pingdotgg/t3code).
The general agent guide is in `CLAUDE.md` / `AGENTS.md`; this file covers only
things specific to the fork relationship.

## The fork-mirroring model

Our version numbers **mirror upstream**. Our release tags are derived from
upstream release tags + fork commits rebased on top. There is no independent
versioning axis for the fork.

- `.github/workflows/sync-upstream.yml` runs every 3 hours. It is the **only**
  thing that should create new release-version tags. Do not manually bump the
  version in `package.json` or tag releases to new numbers — sync-upstream does
  that when upstream ships a new release on the selected channel.
- sync-upstream fetches upstream tags into `refs/tags/upstream/*` (namespaced)
  to avoid clobbering our tags, then rebases our fork commits onto the upstream
  tag and force-pushes `main` plus a release tag. Pushing the release tag is
  what drives the build: `release.yml` has no `schedule:` trigger and fires
  only on tag pushes (and `workflow_dispatch`).
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
      3. lets us re-roll a fork build on the same upstream commit
         (bump `N`) without any tag-delete dance.
- Workflow requires `GH_PAT` (not `GITHUB_TOKEN`) in secrets because
  `GITHUB_TOKEN` cannot push commits that modify workflow files.

If you need to put fork patches on top of upstream, push normal commits to
`main`. The next sync rebases them forward automatically.

### Channel: stable vs nightly

sync-upstream can track either upstream stable releases (`/releases/latest`,
excludes pre-releases) or upstream nightly pre-releases (first release whose
tag matches `v<ver>-nightly.*` or `nightly-v<ver>-nightly.*`).

Channel resolution order (first non-empty wins):

1. `workflow_dispatch` input `channel` — one-off override.
2. Repo variable `SYNC_CHANNEL` — persistent default.
3. Hardcoded fallback: `stable`.

**Flip the persistent default** (no code change, no commit needed):

```bash
gh variable set SYNC_CHANNEL --body nightly --repo jimprince/t3code
gh variable set SYNC_CHANNEL --body stable  --repo jimprince/t3code
gh variable list --repo jimprince/t3code        # verify
```

**One-off run on the other channel** (doesn't change the default):

```bash
gh workflow run sync-upstream.yml --repo jimprince/t3code -f channel=stable
gh workflow run sync-upstream.yml --repo jimprince/t3code -f channel=nightly
```

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

**Switching channels does not retroactively rewrite history.** If you flip
from nightly → stable, the next sync will target the latest stable tag. If
stable is older than our current `HEAD` (likely, since we rode nightlies
ahead), the sync's `git rev-parse --verify <stable_tag>` check may already
see that tag and skip — in which case we're already "at" stable and the next
upstream stable release will pick us back up. If it does try to rebase
backwards, conflicts are likely; resolve locally per the workflow's error
output.

## Build matrix is intentionally minimal

`.github/workflows/release.yml` only builds:

- macOS arm64 (dmg + zip)
- Linux x64 (AppImage)

We deliberately **dropped** Windows x64, Windows arm64, and macOS x64. They
added flake surface without being used. Do not "helpfully" re-add them.

- `fail_on_unmatched_files: false` on the `softprops/action-gh-release@v2` step
  is intentional — it lets the publish step succeed when patterns for dropped
  platforms don't match.
- The 2-attempt retry wrapper around `bun run dist:desktop:artifact` absorbs
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
- `apps/desktop/src/appBranding.ts` returns `"Fork"` for stable builds
  (previously `"Alpha"`).
- `apps/desktop/src/main.ts` uses `"T3 Code (Fork)"` for window titles, user-
  data dir, Windows app model IDs, Linux desktop entries.
- `apps/web/src/branding.ts` has `"Fork"` as the non-Electron fallback.
- `apps/web/index.html` `<title>` is `"T3 Code (Fork)"`.

When merging upstream changes that touch any of these, keep our values.

## macOS/Linux artifacts are unsigned

Release artifacts are **not** Apple Developer ID-signed or notarized. First-
open on macOS is blocked by Gatekeeper; users bypass via right-click → Open,
or `xattr -rd com.apple.quarantine`. If you want to fix this properly, it
requires wiring an Apple Developer cert + notarization credentials into
release.yml — an open TODO, not a missing config.

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
  patch 22 > patch 21. Users on the last clean release get prompted.
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

Long-term fix would be changing sync-upstream's "already synced?" check from
tag-existence to commit-equality (does our `refs/tags/vX` actually contain
upstream's `refs/tags/vX` as ancestor?). Until then, the `-fork.N` convention
sidesteps the whole class of problem.

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
