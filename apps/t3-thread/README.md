# t3-thread

Standalone operator CLI for T3 Code worker threads.

Primary command: `t3-thread`.
Deprecated compatibility alias: `t3-agent` remains in place for old scripts and active threads. Do not use it in new instructions.

Runtime state remains at `~/.config/t3-remote-agents/state.json` so existing paired environments and saved workers continue to work.

The source now lives at `apps/t3-thread` in Brad's T3 Code fork. It remains a
separate workspace package and executable boundary; the move does not make it a
server-internal API or combine it with the unrelated `subagents` tool.

## Quick Start

```bash
t3-thread envs
t3-thread env forget <name>        # local-only; works for unreachable environments
t3-thread projects --env local-mbp
t3-thread models --env local-mbp
t3-thread project list --env local-mbp
t3-thread project add --env local-mbp --path /Users/brad/Programming/repo --title Repo

t3-thread create \
  --name worker-a \
  --env local-mbp \
  --project PROJECT_ID \
  --title "Worker A" \
  --branch t3/worker-a \
  --message "Inspect the repo and fix the issue."

t3-thread status worker-a
```

A real worker exists only after `create` returns a remote `threadId`.

Common lifecycle commands also accept a raw T3 `threadId` directly when you do
not want to create a saved alias first:

```bash
t3-thread settle 22222222-2222-4222-8222-222222222222
t3-thread unsettle 22222222-2222-4222-8222-222222222222
t3-thread status 22222222-2222-4222-8222-222222222222
t3-thread result 22222222-2222-4222-8222-222222222222 --final-message
t3-thread implement 22222222-2222-4222-8222-222222222222
t3-thread send 22222222-2222-4222-8222-222222222222 "Continue from the last checkpoint."
```

Settlement uses the server lifecycle and reads back its state. Settling your own
`T3_THREAD_ID` requires `--self`, including when using a saved alias. During a
turn, `t3-thread settle "$T3_THREAD_ID" --self` returns `deferred: true` and a
background process waits for that turn's final response before settling. It
returns a `logPath` for the eventual result; `deferred` is acceptance, not proof
of settlement. Unsettle cancels the pending request and returns the thread to
the active list without starting a turn. A new turn also cancels the request.
The helper expires after 24 hours and does not survive reboot; retry after a
reboot if still needed.

Notifications routed to a settled thread are held instead of waking it. `settle`
lists the thread's subscriptions, each with the `unsubscribe` command that cuts
it. On unsettle, the thread receives only the newest held notification from
each source. `t3-thread unsettle` releases them at once; after unsettling in the
app, they go out on the watcher's next pass while it is running.

When a worker reaches **Plan Ready**, use `t3-thread implement <agent-or-thread-id>`
to perform the same-thread equivalent of the UI's **Implement** button. The CLI
selects the current unimplemented proposal, switches the thread from plan mode
to build mode, and starts the implementation turn with source-plan tracking.
Use `--plan-id <id>` only when intentionally selecting a specific proposal.
Plain `send` preserves the current interaction mode and therefore does not
replace `implement` for Plan Ready workers.

Resolution order for a raw UUID:

- prefer an existing saved mapping if that thread is already attached locally
- otherwise scan paired environments and infer environment/project metadata from the remote thread shell
- skip unavailable environments and report attempted/unreachable names in search and status JSON
- if not found, report the paired environments checked and any unreachable environments

## Find a Thread by UUID

When all you have is a T3 thread UUID, use `search` before choosing a lifecycle
command or attaching a persistent alias:

```bash
t3-thread search 22222222-2222-4222-8222-222222222222
t3-thread search 22222222-2222-4222-8222-222222222222 --env dev-vm
```

`search` accepts a full UUID only. It returns stable JSON with the thread id,
saved environment key, project id, whether the thread is saved locally, its
saved alias when present, and its available title. It checks a saved mapping
first, then searches paired environments for an exact thread-id match; it does
not search titles or message content. `--env` limits only the remote search. If
the UUID is already saved in a different environment, the command stops with a
clear mismatch error instead of silently bypassing that mapping.

## Creation Model

`t3-thread create` is a thin wrapper over T3 Code's native `thread.turn.start` bootstrap flow.

- The CLI sends `bootstrap.createThread`.
- If `--branch` is present, the CLI sends `bootstrap.prepareWorktree`.
- T3 creates and records the worktree path.
- The CLI records saved names, notification routing, and local monitoring state.

Do not pass a worktree path and do not manually create a git worktree first.

## Common Commands

```bash
t3-thread project list --env local-mbp
t3-thread models --env local-mbp
t3-thread project add --env local-mbp --path /Users/brad/Programming/repo --title Repo
t3-thread project rename --env local-mbp PROJECT_ID "New Title"
t3-thread project set-model --env local-mbp PROJECT_ID --provider codex --model gpt-5.4
t3-thread project set-model --env local-mbp PROJECT_ID --provider opencode
t3-thread project set-model --env local-mbp PROJECT_ID --provider cursor --model composer-2
t3-thread project set-model --env local-mbp PROJECT_ID --provider opencode --model google/antigravity-gemini-3.5-flash-high
t3-thread project remove --env local-mbp PROJECT_ID

t3-thread threads --env local-mbp
t3-thread search 22222222-2222-4222-8222-222222222222
t3-thread status worker-a
t3-thread status 22222222-2222-4222-8222-222222222222
t3-thread worklog worker-a --tail 10
t3-thread worklog 22222222-2222-4222-8222-222222222222 --tail 10
t3-thread implement worker-a
t3-thread implement 22222222-2222-4222-8222-222222222222
t3-thread result worker-a --wait 120 --final-message
t3-thread result 22222222-2222-4222-8222-222222222222 --final-message
t3-thread inbox
t3-thread send worker-a "Narrow the fix."
t3-thread send 22222222-2222-4222-8222-222222222222 "Narrow the fix."
t3-thread archive worker-a
t3-thread archive 22222222-2222-4222-8222-222222222222
t3-thread forget worker-a
```

Supported direct-ID lifecycle commands: `settle`, `unsettle`, `status`, `result`, `worklog`, `implement`, `send`,
`clarify`, `revise`, `complete`, `wait`, `archive`, and `subscribe --watch`.

Use the complete ID printed by the server, including `thread:delegated-task:command%3A...` or `automation:...`, for nesting, settlement, metadata updates, and results. IDs are opaque: do not URL-decode the embedded command namespace.

### Sending to a thread that is still running

`send` (and `clarify` / `revise` / `complete`) to a thread whose turn is still
running is **accepted and queued**, not rejected. The message is written to
`state.json` before the command returns and the watcher dispatches it as a normal
follow-up turn at the next turn boundary. The command output says which happened:

```json
{ "threadId": "...", "dispatched": false, "queued": true, "queuedSendId": "...", "sequence": 3 }
```

- Ordering is FIFO per thread, one dispatched message per turn boundary. Messages
  are never merged: two sends stay two turns, in arrival order.
- `send --no-queue` restores the old behavior and fails instead of holding.
- A queued send survives the CLI exiting, the watcher exiting, sleep, and reboot.
  It only dispatches while a watcher runs on this machine; `send` ensures one.
- An `interrupt` does not drop the queue; the held message dispatches at the
  boundary the interrupt creates. Use `dequeue` to drop it.
- Archiving the target thread drops its queue as `undeliverable`.

```bash
t3-thread queue                # every queued send
t3-thread queue worker-a --open  # only what is still waiting
t3-thread dequeue <queued-send-id>
```

`attach` is still available when you want a persistent local alias. `result --mark-seen`
still requires a saved agent name because read state is stored locally.

Legacy nested commands still work for compatibility:

```bash
t3-thread agent create ...
t3-thread agent status worker-a
```

Use the direct canonical form in all new workflows:

```bash
t3-thread create ...
t3-thread status worker-a
```

## Project Management

`t3-thread project` manages projects on any paired environment, local or remote.
Paths must be absolute paths on the target environment.

```bash
t3-thread project list --env dev-vm
t3-thread models --env dev-vm
t3-thread project add --env dev-vm --path /home/brad/Programming/repo --title Repo --create-dir
t3-thread project rename --env dev-vm PROJECT_ID "Repo"
t3-thread project set-model --env dev-vm PROJECT_ID --provider codex --model gpt-5.4
t3-thread project set-model --env dev-vm PROJECT_ID --provider opencode
t3-thread project set-model --env dev-vm PROJECT_ID --provider cursor --model composer-2
t3-thread project set-model --env dev-vm PROJECT_ID --provider opencode --model google/antigravity-gemini-3.5-flash-high
t3-thread project set-model --env dev-vm PROJECT_ID --clear
t3-thread project remove --env dev-vm PROJECT_ID
```

`--provider` is the T3 Code provider instance id shown by the app, not a
closed CLI allowlist. Built-in ids such as `codex`, `claudeAgent`, `cursor`,
`grok`, and `opencode` work, and custom instance ids such as `codex_personal`
are passed through. `--model` accepts any model slug available for that
provider instance in the app; run `t3-thread models --env <environment>` to
see the live roster. If `--provider` is passed without `--model`, native Codex
prefers `gpt-5.6-terra` when it is live; other providers use their current first
non-custom advertised model. Selection falls back to the static compatibility
default only when live config is unavailable.
OpenCode models must use OpenCode's provider/model slug format, for example
`google/antigravity-gemini-3.5-flash-high` or `openai/gpt-5`.

Safety defaults:

- `project add` only creates missing directories when `--create-dir` is passed.
- `project remove` refuses to remove a project with active threads unless `--force` is passed.
- If multiple active projects share a workspace root, use the project id instead of the path.

## Notifications

When `T3_THREAD_ID` is set, nested `create` auto-subscribes the caller thread to the new worker by default. `create --top-level` requires an explicit `--notify` to add a subscription.
When `T3_ENVIRONMENT_ID` and `T3_ENVIRONMENT_NAME` are also set, the CLI resolves unsaved caller
threads directly from that environment metadata and maps it to the saved environment key used for routing.

- Use `--no-notify` to opt out.
- Use `--notify <saved-agent-or-thread-id>` to route notifications to another subscriber.

### Watcher lifecycle (on-demand)

`create` (with a notify subscription) and `subscribe` auto-spawn a detached background watcher if none is running — best-effort, never blocks the command. It is a singleton (pidfile `~/.config/t3-remote-agents/watch.pid`) and self-exits when idle:

- `--idle-exit <seconds>` (default 900): exit after this long with nothing in flight. It stays alive while any subscribed source thread is still running, any notification is undelivered, or any send is still queued. `0` disables.
- `--max-lifetime <seconds>` (default 21600): runtime backstop. If work is still outstanding, the watcher hands off to a fresh watcher.
- `t3-thread watch --ensure`: spawn one if absent, else no-op (then exit).
- `t3-thread watch --once`: single throwaway scan (no pidfile/idle logic).

The launchd agent `~/Library/LaunchAgents/network.homenetwork.t3-watcher.plist` is **not** auto-loaded; load it manually only if you want a persistent 24/7 watcher.

### Notification delivery status

`t3-thread notifications` shows each routed event's delivery status:

| Status            | Meaning                                                                                                       |
| ----------------- | ------------------------------------------------------------------------------------------------------------- |
| `pending`         | waiting for its next attempt                                                                                  |
| `delivering`      | claimed by a watcher process                                                                                  |
| `delivered`       | sent into the recipient thread                                                                                |
| `delivery-failed` | attempt failed, retrying after a backoff                                                                      |
| `held`            | the recipient is settled; only the newest per source is kept, and it goes out once the recipient is unsettled |
| `blocked`         | the recipient environment's pairing expired; `lastError` names the `t3-thread pair` command that releases it  |
| `undeliverable`   | terminal; recipient archived, subscription or environment gone, or the attempt cap was reached                |

Delivery is oldest-first with at most one notification per recipient per pass, failures back off (15s doubling to 10 min, 6 attempts), and a recipient that is mid-turn is re-offered without spending the attempt budget. Claims are owned by the watcher process that took them, so sleeping mid-delivery does not cause a duplicate send on wake.

## Docs

- Canonical skill: `/Users/brad/.shared/skills/t3-threads/SKILL.md`
- Overseer layer: `/Users/brad/.shared/skills/overseer-thread-management/SKILL.md`
- Runbook: `docs/AGENT_OPERATIONS.md`
- Remote ownership boundary: `docs/REMOTE_T3CODE_UPDATE.md`

This package owns worker-thread lifecycle only. Updating the remote `t3code.service`
is owned by the T3 Code fork's release docs, and VM/service/pairing/project
administration is owned by the shared `t3code-remote-ops` skill. See
`docs/REMOTE_T3CODE_UPDATE.md` for the routing.

## Monorepo Development

From the fork root, use Node `24.13.1` and the workspace toolchain:

```bash
pnpm --filter t3-thread test
pnpm --filter t3-thread typecheck
pnpm --filter t3-thread build
pnpm --filter t3-thread smoke
```

`dist/cli.cjs` is a build artifact, not a tracked file. The `prepare` script
builds it on install, so package-style installs always get a bundle matching
`src/`. It used to be committed with a freshness test guarding it, but the
bundle inlines upstream code, so every upstream sync made it stale and blocked
the rebase; building it removes that failure class entirely.

The CLI imports wire schemas through narrow `@t3tools/contracts` subpaths at
build time and bundles them into `dist/cli.cjs`, so installed commands have no
runtime monorepo dependency or root-barrel startup cost. `src/contracts.ts`
contains only the wider decoding needed for old paired servers and the CLI's
stable model-selection view; do not copy the main contract tree back into this
package.

## Prebuilt operator runtime

Build once with `node scripts/build.mjs` from `apps/t3-thread` after installing
workspace dependencies. `bin/t3-thread` and `pnpm run cli` then use one Node
process to validate the source hash and load `dist/cli.cjs`; ordinary calls do
not run tsx or esbuild. A missing or stale build fails with the explicit build
command. For source development, use `T3_THREAD_DEV=1 bin/t3-thread` or
`pnpm run cli:dev`.

For reviewed deployment, copy `bin/t3-thread` and `bin/t3-thread-deploy` to the
shared bin directory. The deploy helper builds and validates the pinned snapshot
before changing `current`; the wrapper still accepts `T3_THREAD_REPO` and
`T3_THREAD_NODE_BIN`. Updating the wrapper alone leaves old snapshots without a
stamp unable to run until they are explicitly built or redeployed.

Use `t3-thread-deploy --retain-snapshots --from <checkout> --ref <reviewed-ref>`
when runtime directories must be preserved. Preview with `--dry-run`; dependency
commands come from the requested Git ref even before its snapshot exists.
It still builds, verifies, promotes
and restarts the managed watcher, but skips pruning (including `--prune-only`)
and retains a newly created snapshot if preparation fails. Inspect and repair
an incomplete snapshot before retrying: a retained directory is not proof of a
working build. Without the option, existing pruning and cleanup behavior applies.
Keep exact unit, wrapper and `current` receipts for rollback; retained snapshots
stay at their original paths, so no full runtime backup is required. Never remove
one without explicit authorization.

When a Linux user `t3-thread-watcher.service` is loaded, deployment restarts it
through the user bus after promoting the verified snapshot and before pruning.
It then checks the service PID against the boot/start lease and promoted runtime
cwd; a live foreign watcher must not allow deletion of its old runtime.
The service must run the shared wrapper, which follows `current`. A restart or
service-health failure stops pruning and retains the previous runtime; repair
the unit or atomically repoint `current` to the retained snapshot and restart
only the watcher. `--dry-run` and `--prune-only` never restart it. An installed
unit with an unavailable user bus fails closed. Hosts without this managed unit
keep on-demand watcher behavior. Every pruning path, including `--prune-only`,
checks the routing-state lease before deletion. On Linux a live boot/start lease
whose cwd is inside any predecessor blocks all pruning; stop/relaunch that
watcher explicitly before retrying. Unknown or live legacy leases fail closed.
Provably stale Linux leases and live watchers in the retained current runtime
do not block pruning; the guard never removes leases or signals their owners.
On other platforms a present lease blocks pruning until the watcher is stopped
and its lease released through normal CLI lifecycle. These are point-in-time
checks, not a lock against concurrent watcher startup; serialize deployment and
watcher launch. Never delete routing state or leases.

For a persistent Linux watcher, use a user unit enabled under `default.target`
with `ExecStart=<shared-bin>/t3-thread watch --interval 5 --idle-exit 0
--max-lifetime 0`, an explicit Node/shared-bin PATH and HOME, `Restart=always`,
`RestartSec=30s`, and `SendSIGKILL=no`. Enable user lingering for boot startup.
Keep it outside the server's system cgroup and without `PartOf=t3code.service`.
`Restart=always` retries when a live on-demand watcher wins the singleton lease
and the managed command exits successfully. Verify the managed MainPID against
`watch.pid` and its boot/start identity after cutover. A loaded service alone
is not proof that it owns the lease or delivered a notification.

`watch --interval 5` uses five seconds while work remains, and sixty seconds
while idle. Each pass shares thread reads and uses HTTP/RPC within the watcher
process. Unsubscribed sources are not scanned. Settled sources are checked once
per minute; archived and confirmed missing sources are parked until the watcher
restarts. `skippedMappings` flags these mappings without deleting local aliases.
Use `t3-thread forget <name>` to remove an obsolete alias. `status` without a name
reports missing aliases and continues showing the remaining threads.

Notification routing defaults to `all`. Use `create --notify-level attention` or
`subscribe --watch <worker> --level attention` for supervision with direct result
messages. `none` keeps required escalation alerts. Workers can end with
`T3_NOTIFY: quiet` or `T3_NOTIFY: attention`; see
[notification levels](docs/AGENT_OPERATIONS.md#notification-levels-and-quiet-results).

For replying to worker notifications and choosing your subscription level, see
[Thread communication](docs/THREAD_COMMUNICATION.md). The first delivered notice
includes a short guide once per subscriber.

## Notification ownership and handoff

Nested `create` subscribes its caller by default. `create --top-level` does not;
use an explicit `--notify` or `--notify <subscriber>` to opt in. `--no-notify`
disables either route. Always check `notifySubscribed` in the result.

Completion notifications say that a turn completed; pending approvals, questions,
plans, errors, and interruptions say that attention is needed. A reply to a routed
notification does not emit another completion notification. It can still report
an approval, question, plan, error, or interruption. To reduce routine completion notices:

```bash
t3-thread subscribe --watch <source> --level attention
# Restore completion notifications on the same route:
t3-thread subscribe --watch <source> --level all
```

Existing routes continue to include completions unless explicitly changed. Multiple
supervisors may subscribe independently. Unsubscribe cancels queued notifications
for that route; a message already accepted by the server cannot be recalled.

For a supervisor handoff, subscribe the replacement to each retained source,
verify its routes with `subscriptions --subscriber <replacement>`, then unsubscribe
the retiring supervisor from those sources and verify its list is empty. Only then
send the old supervisor its final handoff. Its own close-out uses
`settle "$T3_THREAD_ID" --self`; a different thread uses `settle <old-supervisor>`.
Never infer settlement from a deferred receipt; read its eventual log or status.

Use `queue --open` for current queued work. Plain `queue` is history and includes
terminal records; inspect `status`, `actionable`, `queuedAt`, `ageSeconds`, and
`dispatchedAt` before treating an entry as an instruction.

If creation fails after a transport error, inspect remote threads by title,
project, branch, and creation time before retrying. Every new invocation chooses
a new identity, so retry can create a duplicate; attach an existing thread instead.
Run the CLI under the Node version required by the fork.

Inspect nesting with `t3-thread status <name-or-thread-id>` or list children with
`t3-thread threads --env <environment> --parent <name-or-thread-id>`.
Add `--recursive` for every descendant. Listings include parent ids and available
titles, state, settlement and pin status, using the server read model.

## V2 server compatibility

This port connects with orchestration protocol 2 and launches threads through the native launch RPC. `pending`, `answer --answers JSON`, `approve`, and `deny` address durable runtime request IDs. Responses to requests marked not resumable fail before dispatch. Scoped reads preserve native message attachments and provider instance IDs. Project automation commands require the M3 port. Native order reset and nesting mutation require their later concern ports.
