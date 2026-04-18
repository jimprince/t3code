# LLM_INSTRUCTIONS

Fork-specific knowledge that is **not derivable** from the code or git history.
Future agents working in this repo: read this before touching versioning,
releases, or the sync pipeline.

This repo (`jimprince/t3code`) is a fork of [`pingdotgg/t3code`](https://github.com/pingdotgg/t3code).
The general agent guide is in `CLAUDE.md` / `AGENTS.md`; this file covers only
things specific to the fork relationship.

## The fork-mirroring model

Our version numbers **mirror upstream**. Our `vX` tag = upstream `vX` + fork
commits rebased on top. There is no independent versioning axis for the fork.

- `.github/workflows/sync-upstream.yml` runs daily. It is the **only** thing
  that should create new release-version tags. Do not manually bump the version
  in `package.json` or tag releases to new numbers — sync-upstream does that
  when upstream ships a new stable release.
- sync-upstream fetches upstream tags into `refs/tags/upstream/*` (namespaced)
  to avoid clobbering our tags, then rebases our fork commits onto the upstream
  tag and force-pushes `main` + the shared tag name.
- Workflow requires `GH_PAT` (not `GITHUB_TOKEN`) in secrets because
  `GITHUB_TOKEN` cannot push commits that modify workflow files.

If you need to put fork patches on top of upstream, push normal commits to
`main`. The next sync (or next upstream release) rebases them forward automatically.

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

## Version-collision footgun: v0.0.21

**This one is likely to bite.** We pre-emptively shipped our own `v0.0.21`
(rebrand release) before upstream released theirs. Upstream's latest at the
time of writing is `v0.0.20`; their next release will likely be `v0.0.21`.

When upstream ships `v0.0.21`:

- sync-upstream will check `git rev-parse --verify v0.0.21` — we already have
  the tag — and **silently exit with "nothing to do"**. Upstream's v0.0.21
  changes will never be pulled in. The scheduled sync will keep skipping
  forever until someone notices.
- **Remediation**: delete our v0.0.21 tag on GitHub and locally, then trigger
  sync-upstream manually:

  ```bash
  git push origin :refs/tags/v0.0.21
  git tag -d v0.0.21
  gh workflow run sync-upstream.yml --repo jimprince/t3code
  ```

  sync-upstream will then see v0.0.21 as missing, fetch upstream's v0.0.21,
  rebase our fork commits onto it, and recreate v0.0.21 cleanly.

Long-term fix would be changing sync-upstream's "already synced?" check from
tag-existence to commit-equality (does our `refs/tags/vX` actually contain
upstream's `refs/tags/vX` as ancestor?). Not done yet. Until then, the
remediation above is the workaround.

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
