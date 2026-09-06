# Remote T3 Code Updates — Ownership Boundary

This repo does **not** own updating the remote `t3code.service`. This page exists
so an agent that lands here looking for an update procedure is routed to the
system that actually owns it, instead of following a stale copy.

Do not add release, build, or install steps to this repo. They drift.

## Who Owns What

| Concern                                                                                     | Owner                             | Entry point                                                      |
| ------------------------------------------------------------------------------------------- | --------------------------------- | ---------------------------------------------------------------- |
| Release and update mechanics for `t3code` (build, publish, install, auto-upgrade, rollback) | T3 Code fork (`jimprince/t3code`) | `docs/operations/release.md`, `scripts/headless-auto-upgrade.sh` |
| VM, service, pairing, and project administration                                            | Shared `t3code-remote-ops` skill  | `/Users/brad/.shared/skills/t3code-remote-ops/SKILL.md`          |
| Worker-thread lifecycle                                                                     | This repo                         | [docs/AGENT_OPERATIONS.md](AGENT_OPERATIONS.md)                  |

## Updating The Remote Server

Use the fork. The headless server is updated by an external updater that stages
release tarballs into versioned directories, flips a `current` symlink only
after a health check, then restarts `t3code.service` — with rollback if the new
release fails.

- Procedure and systemd timer: fork `docs/operations/release.md`, sections
  _Headless Server Install / Update_ and _Headless Auto-Update_.
- Canonical updater script: fork `scripts/headless-auto-upgrade.sh`, installed on
  the VM as `~/.local/bin/t3code-headless-upgrade`.

On a healthy VM this is already automated by the `t3code-headless-upgrade.timer`
user timer, so the common case is to verify rather than to run anything.

Never update the server by resetting and rebuilding a source checkout on the VM.
That path is obsolete, destroys uncommitted work in the checkout, and installs a
binary the release tooling does not track.

## Administering The Remote VM

Use the shared `t3code-remote-ops` skill for reaching the dev VM, inspecting or
restarting `t3code.service`, issuing a fresh pairing URL, and adding, renaming,
or removing remote projects. It sources canonical machine values from
`~/.shared/config/local_network.env` and keeps secrets in
`~/.shared/config/secrets.env`.

Once the service is healthy and the project exists, come back here for thread
work.

## What This Repo Owns

`t3-thread` operates worker threads against an already-healthy, already-paired
environment: create, supervise, notify, and retire threads. See
[docs/AGENT_OPERATIONS.md](AGENT_OPERATIONS.md).

If a thread command fails because the environment is unreachable, unpaired, or
the service is down, that is a substrate problem. Fix it through the two owners
above, then retry the thread command.
