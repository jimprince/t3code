# T3 Code fork instructions

This repository (`jimprince/t3code`) is a maintained fork of
[`pingdotgg/t3code`](https://github.com/pingdotgg/t3code). This file is the
task router and the source of fork-only constraints. Detailed procedures live
in the linked skill and runbooks.

## Before changing the tree

- Use focused tests, formatting, and typechecks for the files you change. Do
  not run repo-wide checks locally unless requested; CI owns the broad gates.
- Tests import from `"vite-plus/test"`, not `"vitest"`. Prefer precise edits
  over bulk regex rewrites, and run `vp fmt` on touched files.
  Match Node to `package.json` engines. If `vp` is absent from PATH, use
  the installed `./node_modules/.bin/vp`; a package-manager fallback can
  trigger dependency installation even for a read-only check.
- Treat every reported product symptom and boundary as an acceptance
  criterion. Name the production-path test for each before claiming it fixed;
  an adjacent green unit test is not evidence for an unexercised outcome.
- Do not write to live `~/.t3/userdata`, kill processes by name/pattern, or set
  `VITE_HTTP_URL`/`VITE_WS_URL` for local development. Use worktree-local
  state and track any process you start by PID.
- New fork behavior belongs in the StGit concern stack, never as a plain commit
  beside it. Read the next section before editing.

### Pull-request and configured-Gitea fixes

For linked-PR work, trace creation from
[`handlers.ts`](./apps/server/src/mcp/toolkits/pullRequests/handlers.ts) and
persisted refresh from
[`PullRequestSyncReactor.ts`](./apps/server/src/orchestration/PullRequestSyncReactor.ts).
The target repository/provider can differ from the thread's project.

Cover both creation and status refresh for same-project and cross-project or
cross-host targets. Use the target provider's identity and web origin. If a
numeric reference's provider is unresolved, require its canonical URL instead
of inventing GitHub. Include already-saved bad links and stale snapshots, and
exercise normal persistence through the client-facing result; never repair live
user data to make a test pass.

## Change, rebase, or publish the fork stack

Start with the repo-local
[`fork-patch-stack` skill](./.agents/skills/fork-patch-stack/SKILL.md), then read
the [maintenance runbook](./docs/operations/fork-maintenance.md) and relevant
entries in the [ordered inventory](./docs/operations/fork-inventory.toml).

- Existing-purpose work refreshes its owning patch. A genuinely independent,
  droppable concern gets a new patch and inventory stanza. Patch count is not
  capped; file overlap is not ownership.
- Keep implementation, focused tests, applicable docs, and inventory ownership
  together. Never use `git add -A` for a patch refresh.
- Rebase with `stg rebase`, not plain Git rebase. At each conflict ask
  `retire -> narrow -> relocate -> adapt`; repair the currently failing patch
  and never create a new patch during conflict resolution.
- Before editing a freshly fetched stack, capture immutable leases with
  `scripts/ci/prepare-stgit-publication`. Publish only through
  `scripts/ci/publish-stgit-stack --check|--push`; generated release stamps
  remain tag-only.
- Preserve preparation-time main, stack, and complete patch-ref leases. Never
  refresh a rejected lease against newly observed state.

For every user-visible fork feature, fix, performance change, or removal, add a
stable-ID [authored release-note entry](./docs/release-notes/entries/README.md)
in its owning concern. Describe user behavior, not patch mechanics. Pure
upstream replay and structural patch rewrites get no entry; published entries
remain historical release data.

Retiring persisted behavior requires a historical-data transition even when
upstream supplies its replacement. Preserve shipped migration IDs and old
event/snapshot/transfer reads, and test old data replay, migration ledgers,
restart, and idempotency. Follow
[Retiring persisted functionality](./docs/operations/fork-maintenance.md#retiring-persisted-functionality)
and the [packaged fixtures](./scripts/fixtures/thread-history/README.md).

### Sandboxed candidate agents

If stack refs are unavailable or Git metadata is read-only, do not install,
retry blocked network access, run `stg init`, commit, or fabricate refs. Deliver
a finished working tree plus exact changed paths, real test commands/results,
and the owning-patch/new-concern recommendation. Dependencies are preinstalled.

## Release and upstream-sync routing

Read the canonical [release runbook](./docs/operations/release.md) for commands,
tag preparation, CI evidence, signing/notarization, mobile delivery, headless
upgrades, verification, and troubleshooting.

- Versions mirror upstream; do not invent an independent fork version.
- Preserve the fork's app identity and installation isolation. Builder and
  runtime branding, not upstream package metadata alone, determine the name.
- `sync-upstream.yml` automatically selects the latest upstream nightly once
  daily at 09:00 UTC. Stable and combined syncs are explicit dispatches. Keep
  this upstream-migration lane enabled and separate from feature releases.
- `fork-push-nightly.yml` handles qualifying packaged-source pushes to `main`.
  It must release the next `-fork.N` suffix for the one upstream nightly tag
  exactly matching the StGit integrated base. It must never select or replay a
  newer upstream release. No/ambiguous nightly match fails closed; a stable
  integrated base skips with an explicit message.
- Feature-push tags use `vX.Y.Z-nightly.YYYYMMDD.RUN-fork.N`. They point at a
  direct stamped child while `main` remains the unstamped stack tip. Existing
  tags on that source skip safely.
- Preserve exact-source CI evidence, source ancestry, immutable publication
  leases/snapshots, tag-child version stamping, atomic main/metadata/tag
  publication, packaged historical startup checks, and public release checks.
- `release.yml` is driven by tag push or explicit manual dispatch and never
  writes `main`. A manual same-base reroll uses the next explicit `-fork.N`.
- Release notes are rendered from authored fork entries plus upstream commits;
  do not replace them with generated commit-only prose.

The release matrix is intentionally limited to macOS arm64 Electron
(DMG/zip/updater manifest) and Linux x64 headless tarball. Do not re-add Windows,
Linux Electron/AppImage, or macOS x64 without an explicit product decision.
Mobile is a separate lane: the legacy `mobile-eas-development.yml` runs only by
manual dispatch, while production App Store/TestFlight delivery follows the
release runbook.

When reporting remote build status, distinguish macOS Electron, Linux/headless,
and mobile rather than treating one green job as all deliverables.

## Discovery

- [Fork documentation index](./docs/fork.md)
- [Release operations](./docs/operations/release.md)
- [Stack maintenance and recovery](./docs/operations/fork-maintenance.md)
- [Fork CI](./docs/operations/ci.md)
- [Mobile configuration and fork overlay](./apps/mobile/README.md)
- [Patch inventory](./docs/operations/fork-inventory.toml)
- [Reliability measurement](./docs/operations/fork-maintenance.md#measure-update-reliability)

Keep stack maintenance in a clean `stgit/adopt` worktree with fetched metadata.
Stop if the series is unexpectedly empty or metadata does not describe `HEAD`.
