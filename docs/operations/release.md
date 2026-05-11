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
- Release tags point at commits where releasable package versions already
  match the release tag. This keeps tag-checkout/headless installs reporting
  the same version as the desktop release.

## Fork-Interim Trigger

`fork-interim-release.yml` publishes updater-visible stable fork builds only
for changes that can affect packaged app/runtime output: `apps/**`,
`packages/**`, `assets/**`, root package/build files, and desktop artifact
build inputs.

Docs, workflow maintenance, release helper scripts, and other repo plumbing
should not create `vNEXT-fork.N`. Use manual `release.yml` dispatch if a
maintenance-only commit genuinely needs to ship as a desktop update.

Before pushing `vNEXT-fork.N`, the workflow stamps the releasable package
versions and lockfile, then tags the stamped commit. That package stamp is
required because the headless `t3` server reports its version from
`apps/server/package.json`.

## Normal Commands

Optionally start the local Apple Silicon runner before a desktop release:

```bash
t3code-mac-runner start 7200
```

Release preflight prefers this runner when it is online and idle. If it is
offline or busy, the macOS build uses GitHub-hosted `macos-15` instead.

Sync stable or nightly from upstream:

```bash
gh workflow run sync-upstream.yml --repo jimprince/t3code -f channel=stable
gh workflow run sync-upstream.yml --repo jimprince/t3code -f channel=nightly
```

For both channels, `sync-upstream.yml` rebases fork commits onto the selected
upstream tag, stamps package versions to the derived fork release version, and
pushes the release tag at that stamped commit.

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
- Linux x64 headless server:
  `t3-headless-<version>-linux-x64.tar.gz`.

When Brad asks for remote build or build status in this fork, check and report
three lanes separately:

1. mac Electron app: the `Release` workflow's macOS arm64 build and published
   mac assets.
2. Linux/headless app: the `Release` workflow's Linux x64 build and published
   `t3-headless-<version>-linux-x64.tar.gz` asset.
3. Mobile app: the separate `feature/mobile-track` `Mobile Track EAS Update`
   workflow and its EAS publish result. Mobile is not part of `release.yml` on
   `main`.

Do not re-add Linux Electron/AppImage, Windows, or macOS x64 unless the user
explicitly changes the support target.

macOS arm64 builds prefer the local self-hosted `t3code-mac-arm64` runner when
it is online and idle. During release preflight, `release.yml` checks the
runner state through the GitHub Actions API; if the local runner is offline or
busy, the macOS build uses GitHub-hosted `macos-15` instead. GitHub Actions
cannot migrate a job that is already queued on a self-hosted label, so the
fallback decision must happen before the macOS build job is created.

Nightly preflight and headless Linux installs skip dependency lifecycle scripts
so native dependency hangs do not block macOS updater releases.

The headless Linux x64 tarball is required for both stable and nightly
releases. It is built in a separate Ubuntu job, includes `bin/t3`,
`apps/server/dist/bin.mjs`, `apps/server/dist/client/**`, and production
`node_modules`, and is smoke-tested after a clean unpack before publication.
The target VM must have Node.js 22.16 or newer; the current release workflow
uses the repo `package.json` Node version.

## Headless Server Install / Update

The headless server does not use Electron's in-app updater. Treat it like a
Linux daemon: an external updater stages release tarballs into versioned
directories, flips a `current` symlink only after validation, then restarts
`t3code.service`.

This is safe while the app is running. The running Node process keeps using the
files it already opened; the updater never overwrites that active release
directory. Existing browser clients may disconnect during the final service
restart, then reconnect to the new version. If the new release fails its health
check, the updater flips `current` back to the previous release and restarts
again.

Discover the latest fork release before installing or testing. Do not hardcode
an old nightly tag:

```bash
gh release list --repo jimprince/t3code --limit 10
```

Install or update the remote VM from a release asset:

```bash
set -euo pipefail

repo="jimprince/t3code"
tag="<release-tag>"
version="${tag#v}"
root="/home/brad/.local/share/t3code-server"
release_dir="$root/releases/$version"
asset="t3-headless-${version}-linux-x64.tar.gz"

mkdir -p "$root/releases"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

gh release download "$tag" --repo "$repo" --pattern "$asset" --dir "$tmp"
mkdir -p "$release_dir"
tar -xzf "$tmp/$asset" -C "$release_dir" --strip-components 1
ln -sfn "$release_dir" "$root/current"

"$root/current/bin/t3" --version
sudo systemctl restart t3code.service
sudo systemctl status t3code.service --no-pager
curl -I http://100.64.0.4:3773/
```

The service command should run the current symlink:

```bash
/home/brad/.local/share/t3code-server/current/bin/t3 serve \
  --mode web \
  --host 100.64.0.4 \
  --port 3773 \
  --no-browser \
  --base-dir /home/brad/.local/share/t3code-dev
```

### Headless Auto-Update

The canonical updater script is `scripts/headless-auto-upgrade.sh`. Install it
on the VM as `~/.local/bin/t3code-headless-upgrade` and run it from a systemd
timer. By default it tracks the latest stable GitHub release from
`jimprince/t3code`; set `T3CODE_HEADLESS_CHANNEL=nightly` only for an explicit
nightly host.

Recommended user timer:

```ini
# ~/.config/systemd/user/t3code-headless-upgrade.service
[Unit]
Description=Update T3 Code headless server from GitHub Releases

[Service]
Type=oneshot
Environment=T3CODE_HEADLESS_CHANNEL=stable
Environment=T3CODE_HEADLESS_ROOT=%h/.local/share/t3code-server
ExecStart=%h/.local/bin/t3code-headless-upgrade
```

```ini
# ~/.config/systemd/user/t3code-headless-upgrade.timer
[Unit]
Description=Check for T3 Code headless server updates

[Timer]
OnCalendar=*-*-* 05:20:00
RandomizedDelaySec=45m
Persistent=true
Unit=t3code-headless-upgrade.service

[Install]
WantedBy=timers.target
```

Enable and inspect it:

```bash
systemctl --user daemon-reload
systemctl --user enable --now t3code-headless-upgrade.timer
systemctl --user list-timers t3code-headless-upgrade.timer
journalctl --user -u t3code-headless-upgrade.service -n 100 --no-pager
```

The timer checks once per day at 05:20 UTC with up to 45 minutes of randomized
delay. `Persistent=true` makes systemd run a missed check after the machine
comes back.

For a user timer to run after reboot before the user logs in, enable lingering
once with `sudo loginctl enable-linger brad`. If lingering is unavailable, use
a system timer that runs the same script as the install user.

Newer clients can also request an immediate server-side check when the connected
Linux server reports an older `serverVersion`. That request goes through the
authenticated websocket RPC `server.requestHeadlessUpdateCheck`; the server
rate-limits it and starts `t3code-headless-upgrade.service` through
`systemctl --user`, so the updater runs outside the T3 server process and can
safely restart `t3code.service`. Non-Linux hosts or Linux hosts without the
upgrade service report `unsupported` and do nothing.

If the timer runs while `t3code.service` is active, it downloads and validates
the new release first. Downtime is limited to the final restart. The updater
keeps the previous release for rollback and prunes older releases after a
successful update.

## Nightly Release Concurrency

`release.yml` puts all nightly tag pushes in the shared `release-nightly`
concurrency group with `cancel-in-progress: true`. If multiple upstream
nightlies queue up (for example because the self-hosted macOS runner was
offline overnight), only the newest one builds; older queued/in-progress
nightly runs are cancelled. Stable releases (`v0.0.21`, `v0.0.22-fork.N`) and
manual `workflow_dispatch` runs use per-run groups and always complete, so
this does not affect stable update delivery.

To force an older nightly to ship anyway, dispatch `release.yml` manually with
the desired version — manual dispatch always gets a unique concurrency group:

```bash
gh workflow run release.yml --repo jimprince/t3code \
  --ref main \
  -f channel=stable \
  -f version=v0.0.22-nightly.20260430.158-fork.1 \
  -f target_ref=v0.0.22-nightly.20260430.158-fork.1
```

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

Smoke-test a downloaded headless asset locally:

```bash
bun run smoke:headless:artifact -- \
  --artifact release/t3-headless-<version>-linux-x64.tar.gz \
  --version <version>
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

macOS release artifacts are Developer ID-signed and notarized when all required
Apple secrets are present: `CSC_LINK`, `CSC_KEY_PASSWORD`, `APPLE_API_KEY`,
`APPLE_API_KEY_ID`, and `APPLE_API_ISSUER`. The release workflow logs
`macOS signing enabled.` before the desktop build and Electron Builder should
later log `notarization successful`.

If any required Apple secret is missing, the macOS build intentionally proceeds
unsigned and logs `macOS signing disabled (missing one or more Apple signing
secrets).` Do not print or inspect secret values; use `gh secret list --repo
jimprince/t3code` only to confirm secret names exist. The Linux headless tarball
is not code-signed. Windows signing setup is intentionally omitted because
Windows builds are not part of the fork release matrix.

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
- macOS job never starts: check the preflight "Resolve macOS runner" step. It
  should choose GitHub-hosted `macos-15` when the local runner is offline or
  busy. If you specifically want to use the local machine, start it with
  `t3code-mac-runner start 7200` and verify it is online with the
  `t3code-mac-arm64` label before dispatching or rerunning.
