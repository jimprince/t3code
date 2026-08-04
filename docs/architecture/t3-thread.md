# `t3-thread` Operator CLI

`apps/t3-thread` is the operator-facing CLI for creating, supervising,
continuing, notifying, and retiring real T3 Code worker threads. It was imported
from Brad's standalone `t3-thread` repository with history preserved.

## Boundary

The CLI is colocated with T3 Code so wire-format and lifecycle changes can be
tested in the same tree, but it remains a separate workspace application:

- package and executable names remain `t3-thread` (plus the deprecated
  `t3-agent` compatibility bin)
- it produces a self-contained `dist/cli.cjs` for package-style installation
- it talks to an already-running T3 Code environment through public HTTP and
  WebSocket/RPC boundaries
- it does not import server implementation layers or become part of the web or
  desktop runtime

`apps/` is the correct home because this is an executable operator surface, not
a reusable internal library.

## Compatibility Contracts

The CLI intentionally retains a small vendored T3 contract snapshot. That layer
normalizes older `provider` model-selection shapes and current `instanceId`
wire shapes, plus legacy array-shaped model options, so one CLI can supervise
paired environments across rolling upgrades. Replacing it with the current
workspace contracts requires an explicit compatibility adapter and cross-version
tests; a direct import would silently narrow support.

The vendored schemas use the monorepo's Effect version and are covered by the
CLI's compatibility tests. They are not a second server-domain owner.

## Not `subagents`

Brad's `subagents` repository remains independent:

| Tool        | Responsibility                                                                                 | Runtime substrate          |
| ----------- | ---------------------------------------------------------------------------------------------- | -------------------------- |
| `t3-thread` | Persistent T3 worker lifecycle, paired environments, projects, notifications, archived history | T3 Code HTTP/WebSocket/RPC |
| `subagents` | Short-lived local model subprocess fan-out and result capture                                  | Local CLI processes        |

Neither tool depends on the other at runtime. `t3-thread` may use `subagents`
only as a development-time fresh-agent validation harness; that does not make
`subagents` part of T3 thread execution.

## Operations Ownership

| Concern                                                        | Owner                                                                           |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Worker lifecycle and notification routing                      | `apps/t3-thread` plus the shared `t3-threads` skill                             |
| VM access, service, pairing, and remote project administration | shared `t3code-remote-ops` skill                                                |
| Build, release, install, auto-upgrade, rollback                | this fork's `docs/operations/release.md` and `scripts/headless-auto-upgrade.sh` |

Detailed CLI operations remain in
[`apps/t3-thread/docs/AGENT_OPERATIONS.md`](../../apps/t3-thread/docs/AGENT_OPERATIONS.md).

The canonical local operator checkout is
`/Users/brad/Programming/t3code-fork/apps/t3-thread`; shared wrappers should enter
that workspace and run its pnpm `cli` script. The former standalone checkout is
retained only as a migration/audit source after cutover.
