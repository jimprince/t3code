# Release Workflow

This is the operational release guide for the fork at `jimprince/t3code`.
`LLM_INSTRUCTIONS.md` is still the source of truth for the fork model; this
file is the concise runbook.

## Release Model

- `sync-upstream.yml` checks upstream every 3 hours and can also be dispatched
  manually.
- `release.yml` builds only after a release tag is pushed, or when manually
  dispatched with an explicit version.
- Versions mirror upstream. Do not invent independent fork version numbers.
- Stable upstream tags are reused verbatim, for example `v0.0.21`.
- Stable fork-only interim builds use `vNEXT-fork.N`, for example
  `v0.0.22-fork.1`.
- Nightly fork builds use `vX.Y.Z-nightly.YYYYMMDD.RUN-fork.N`.

## Fork-Interim Trigger

`fork-interim-release.yml` publishes updater-visible stable fork builds only
for changes that can affect packaged app/runtime output: `apps/**`,
`packages/**`, `assets/**`, root package/build files, and desktop artifact
build inputs.

Docs, workflow maintenance, release helper scripts, and other repo plumbing
should not create `vNEXT-fork.N`. Use manual `release.yml` dispatch if a
maintenance-only commit genuinely needs to ship as a desktop update.

## Normal Commands

Start the local Apple Silicon runner before any desktop release:

```bash
t3code-mac-runner start 7200
```

Sync stable or nightly from upstream:

```bash
gh workflow run sync-upstream.yml --repo jimprince/t3code -f channel=stable
gh workflow run sync-upstream.yml --repo jimprince/t3code -f channel=nightly
```

Check both channels:

```bash
gh workflow run sync-upstream.yml --repo jimprince/t3code -f channel=
```

Stop the runner when the release is done:

```bash
t3code-mac-runner stop
```

## Rerolling A Nightly For Updater Testing

`sync-upstream.yml` skips an upstream nightly once any
`${upstream_tag}-fork.*` tag exists. To publish another build from the same
upstream nightly, dispatch `release.yml` directly with the next `-fork.N`
version.
Manual dispatch also accepts `target_ref` when the fixed workflow on `main`
should build and publish a specific existing tag or commit.

Important quirk: `release.yml` currently exposes only `channel=stable` in the
manual dispatch form. That is fine; the workflow derives the real release
channel from the version string. Any version containing `-nightly.` is built as
nightly.

```bash
gh workflow run release.yml --repo jimprince/t3code \
  -f channel=stable \
  -f version=v0.0.22-nightly.20260423.108-fork.2
```

Use `target_ref` when recovering an existing tag from a fixed workflow on
`main`:

```bash
gh workflow run release.yml --repo jimprince/t3code \
  --ref main \
  -f channel=stable \
  -f version=v0.0.22-nightly.20260427.135-fork.1 \
  -f target_ref=v0.0.22-nightly.20260427.135-fork.1
```

Validated path: an installed `v0.0.22-nightly.20260423.108-fork.1` app found
`v0.0.22-nightly.20260423.108-fork.2` as available through
`nightly-mac.yml`.

## Build Matrix

The fork intentionally builds only:

- macOS arm64: DMG, zip, blockmaps, and `latest-mac.yml` or `nightly-mac.yml`.
- Linux x64: AppImage and updater metadata.

Do not re-add Windows or macOS x64 unless the user explicitly changes the
support target.

Nightly preflight and Linux installs skip dependency lifecycle scripts so
native dependency hangs do not block macOS updater releases. Nightly Linux is
best-effort: a Linux-only nightly failure must not block a macOS updater
release as long as `nightly-mac.yml` exists. Stable releases still require the
configured matrix to pass with full installs.

## Updater Requirements

- Runtime updater: `electron-updater` in `apps/desktop/src/main.ts`.
- Packaged update provider: GitHub Releases.
- Repository source: `T3CODE_DESKTOP_UPDATE_REPOSITORY`, otherwise
  `GITHUB_REPOSITORY`.
- Stable channel metadata: `latest*.yml`.
- Nightly channel metadata: `nightly*.yml`.
- macOS requires both the DMG and zip because Squirrel.Mac uses the zip payload.
- `scripts/build-desktop-artifact.ts` must write `channel: nightly` into
  `app-update.yml` for nightly versions.
- `apps/desktop/src/updateChannels.ts` must continue accepting
  `*-nightly.YYYYMMDD.RUN-fork.N` as the nightly channel.

If testing a private repo build locally, the app can use
`T3CODE_DESKTOP_UPDATE_GITHUB_TOKEN` or `GH_TOKEN` at runtime for updater HTTP
requests. Do not commit tokens or print them in logs.

## Verification

Watch a workflow:

```bash
gh run watch <run-id> --repo jimprince/t3code --exit-status
```

Inspect a release and its assets:

```bash
gh release view <tag> --repo jimprince/t3code \
  --json tagName,isPrerelease,publishedAt,url,assets
```

Inspect the nightly mac feed:

```bash
curl -fsSL \
  https://github.com/jimprince/t3code/releases/download/<tag>/nightly-mac.yml \
  | sed -n '1,80p'
```

Check the installed desktop app updater log:

```bash
tail -n 160 ~/.t3/userdata/logs/desktop-main.log \
  | rg -i 'desktop-updater|Update available|Ignoring|No updates'
```

Expected updater proof line:

```text
[desktop-updater] Update available: 0.0.22-nightly.20260423.108-fork.2
```

## Signing

Release artifacts are currently unsigned unless Apple signing secrets are
present. macOS users may need right-click Open or quarantine removal for first
launch. Windows signing setup is intentionally omitted because Windows builds
are not part of the fork release matrix.

## Troubleshooting

- `403 Resource not accessible by integration` while publishing a release:
  ensure `release.yml` grants `contents: write`, the release step can use
  `secrets.GH_PAT || github.token`, and the repo has a release-capable
  `GH_PAT` secret. Do not print or inspect the secret value.
- Nightly release publishes but updater does not see it: confirm the release
  has `nightly-mac.yml`, the app is on the `nightly` update channel, and the
  version matches `*-nightly.YYYYMMDD.RUN-fork.N`.
- Nightly feed points at an assetless release: delete the orphan release/tag or
  republish it with the required updater assets. Assetless nightly feed entries
  poison updater discovery.
- macOS job never starts: start the local runner with
  `t3code-mac-runner start 7200` and verify it is online with the
  `t3code-mac-arm64` label.
