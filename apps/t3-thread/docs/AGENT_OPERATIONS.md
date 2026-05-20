# Agent Operations

Canonical runbook for supervising T3-based agents with this repo.

## CLI Form

Examples below use `t3-thread <command>` (the wrapper in `~/.shared/bin/t3-thread`), which works from any cwd. Inside this repo `t3-thread <command>` is equivalent; pick whichever matches the shell you are in. Both forms invoke `tsx src/cli.ts`, so edits to `src/` are picked up on the next invocation with no rebuild step.

## Quick Start

1. Check saved environments:
   - `t3-thread envs`
2. Discover projects on the target environment:
   - `t3-thread projects --env <environment>`
   - `t3-thread project list --env <environment>`
3. Create a branch-pinned delegated thread for the target project:
   - `t3-thread create --name <agent> --env <environment> --project <project-id> --title "<title>" --branch <branch> --message "<brief>"`
   - When running from inside a T3 caller thread, caller notification is the default.
   - Add `--no-notify` when you do not want the caller auto-subscribed to the new worker.
   - Add `--notify <subscriber>` when you want a specific saved subscriber agent/thread to own notifications for the new worker instead.
4. Watch for results:
   - `t3-thread status <agent>`
   - `t3-thread inbox`
5. Review and acknowledge output:
   - `t3-thread result <agent> --assistant-only --tail 1 --mark-seen`

## Environments

List paired environments:

```bash
t3-thread envs
```

Pair a new environment from a pairing URL:

```bash
t3-thread pair --name <name> --pairing-url "http://host:3773/pair#token=PAIRCODE"
```

Pair from host plus credential:

```bash
t3-thread pair --name <name> --host http://host:3773 --credential PAIRCODE
```

The runtime state is stored in `~/.config/t3-remote-agents/state.json`.

## Project Discovery

Before creating a delegated thread, discover the correct project id on the target environment:

```bash
t3-thread projects --env <environment>
```

This returns the project id, title, workspace root, and default model selection.

## Project Management

Manage projects through the same paired environment model used for threads. This works for local and remote T3 Code servers as long as the environment is paired:

```bash
t3-thread project list --env <environment>
t3-thread project add --env <environment> --path <absolute-workspace-root> --title "<title>"
t3-thread project rename --env <environment> <project-id-or-absolute-workspace-root> "<new-title>"
t3-thread project set-model --env <environment> <project-id-or-absolute-workspace-root> --provider codex --model gpt-5.4
t3-thread project set-model --env <environment> <project-id-or-absolute-workspace-root> --clear
t3-thread project remove --env <environment> <project-id-or-absolute-workspace-root>
```

Safety rules:

- Project paths must be absolute paths on the target environment. Do not pass relative paths or `~`.
- `project add` refuses missing workspace roots unless `--create-dir` is passed.
- `project add` refuses duplicate active workspace roots.
- `project rename`, `project set-model`, and `project remove` resolve exact project id first, then exact workspace root.
- If multiple active projects share the same workspace root, re-run with the project id.
- `project remove` refuses to remove a project with active threads unless `--force` is passed.

Use SSH-based `t3 project add/remove/rename` only as a substrate fallback when the target server is not paired or the T3 service is unhealthy.

## Branch-Pinned Delegation

Always branch-pin delegated work for real project tasks. Do not rely on the environment default checkout.

Creation is intentionally a thin wrapper over T3 Code's native `thread.turn.start` bootstrap flow:

- the CLI sends `bootstrap.createThread`
- if `--branch` is present, the CLI sends `bootstrap.prepareWorktree`
- T3 creates the worktree, records the resulting path, and starts the first turn
- the CLI records the saved agent name, thread id, and notification routing
- the CLI does not call `git.createWorktree` directly, and operators should not pass a worktree path

Canonical pattern:

```bash
t3-thread create \
  --name <agent-name> \
  --env <environment> \
  --project <project-id> \
  --title "<thread title>" \
  --branch <git-branch> \
  --message "<delegation brief>"
```

Recommended:

- `--branch` should be the exact branch you expect the worker to use. The CLI passes it to T3's native `thread.turn.start` bootstrap flow.
- T3 chooses and records the worktree path. Do not pass or manage a worktree path from this wrapper.
- Reuse the same `--name` if you want to replace a failed or obsolete saved agent mapping.
- When you invoke `t3-thread create` from inside a T3 caller thread, that caller is auto-subscribed to completion/attention events from the new worker by default.
- Add `--no-notify` when you want to suppress that default subscription.
- Add `--notify <subscriber>` when you want to subscribe a different saved agent by name or thread id at create time.

If you omit `--branch` for project work, T3 creates a normal local thread on the project checkout instead of a worktree-backed delegated branch.

Post-create reliability checklist:

- Confirm the command returned JSON containing `threadId`.
- Immediately run `t3-thread status <agent>`.
- If the state is `running`, the worker is live.
- If the state is `idle`, `error`, or `stopped`, run `t3-thread worklog <agent> --tail 10` before retrying.
- When replacing a bad worker, reuse the same `--name`; the local saved mapping will point to the replacement thread.
- Never report a worker as created unless you can provide the saved agent name and remote `threadId`.

`--notify` behavior:

- no flag: if `T3_THREAD_ID` is set, the current caller thread is auto-subscribed by default
- no flag: if `T3_THREAD_ID` is not set, create still succeeds without a subscription
- `--no-notify` disables the default caller subscription
- bare `--notify` requires `T3_THREAD_ID` to be set and forces caller subscription explicitly
- bare `--notify` resolves the caller thread from paired environments even when it is not saved in local agent state
- `--notify <subscriber>` accepts a saved agent name or saved thread id and does not require `T3_THREAD_ID`
- persists the same subscription you would otherwise create manually with `agent subscribe --watch <new-agent>`
- does not replace manual `subscribe`; it is the create-time ownership wiring path

## Common Lifecycle Tasks

List saved agents:

```bash
t3-thread list
```

Attach a saved name to an existing thread:

```bash
t3-thread attach --name <agent> --env <environment> --thread <thread-id> --project <project-id>
```

Check compact status:

```bash
t3-thread status
t3-thread status <agent>
```

Inspect the recent work log for provider/runtime failures:

```bash
t3-thread worklog <agent> --tail 10
```

See which agents need attention:

```bash
t3-thread inbox
t3-thread inbox --env <environment>
```

Send follow-up instructions:

```bash
t3-thread send <agent> "Narrow the fix."
t3-thread clarify <agent> "What is blocking you?"
t3-thread revise <agent> "Redo this without touching generated files."
t3-thread complete <agent>
```

Wait for a state transition:

```bash
t3-thread wait <agent> --for completion --timeout 600 --interval 5
t3-thread wait <agent> --for attention
```

Review output only when needed:

```bash
t3-thread result <agent> --assistant-only --tail 1
t3-thread result <agent> --assistant-only --tail 1 --mark-seen
t3-thread result <agent> --wait 120 --final-message
```

Notes:

- `--final-message` returns the terminal assistant message for the latest turn. It first scans the thread for the last assistant message whose `turnId` matches `latestTurn.turnId`, then falls back to `latestTurn.assistantMessageId`, and finally returns nothing if neither resolves. This avoids returning a stale setup/progress message when T3 pins `assistantMessageId` to an early message in the turn.
- `--wait <seconds>` waits for the current/latest turn to complete before reading, so the common “wait, then fetch the final answer” path can happen in one command.

Archive a stale remote thread through T3 RPC:

```bash
t3-thread archive <agent>
```

Forget a saved local mapping after the thread is archived or otherwise no longer needed:

```bash
t3-thread forget <agent>
```

Cleanup timing:

- Keep a thread attached when it is a standing overseer/coordinator, owns an active roadmap slice, or is likely to receive near-term follow-up that benefits from preserved identity.
- Retire a thread when the work is completed and merged, superseded by a replacement thread, launched on the wrong branch and replaced, or abandoned after the investigation is no longer worth continuing.
- Use the supported order: `t3-thread archive` first for the remote thread, then `t3-thread forget` for the local mapping.
- Remove related branches or worktrees only after confirming no retained artifact, comparison page, or follow-up task still depends on them.

When cleaning up the current T3 thread's own checkout:

1. Confirm there are no repo changes to preserve:
   - `git status --short --branch`
2. From the main checkout, remove the worker worktree:
   - `git worktree remove <worker-worktree-path>`
3. Delete the now-unused branch:
   - `git branch -d <worker-branch>`
4. Verify both are gone:
   - `git worktree list --porcelain`
   - `git branch --list <worker-branch>`

Do not archive the current T3 thread before sending the final response from that same thread. Leave it unarchived long enough for the response to land cleanly; archive/forget it later from another controlling thread if needed.

Resolve the current caller from `T3_THREAD_ID`:

```bash
t3-thread caller
```

`agent caller` reports the caller even when that thread is not saved locally, as long as it can be found in a paired environment. In that case the returned record shows `saved: false`.

Register the calling T3 thread as a subscriber for a saved source agent:

```bash
t3-thread subscribe --watch <agent>
```

This works for the raw calling thread even when it is not saved locally, as long as the thread can be found in a paired environment.

Create a worker and use the default caller auto-subscription:

```bash
T3_THREAD_ID=<caller-thread-id> t3-thread create \
  --name <agent-name> \
  --env <environment> \
  --project <project-id> \
  --title "<thread title>" \
  --branch <git-branch>  \
  --message "<delegation brief>"
```

Create a worker but opt out of default notifications:

```bash
T3_THREAD_ID=<caller-thread-id> t3-thread create \
  --name <agent-name> \
  --env <environment> \
  --project <project-id> \
  --title "<thread title>" \
  --branch <git-branch>  \
  --message "<delegation brief>" \
  --no-notify
```

Create a worker and auto-subscribe a different saved subscriber in one command:

```bash
t3-thread create \
  --name <agent-name> \
  --env <environment> \
  --project <project-id> \
  --title "<thread title>" \
  --branch <git-branch>  \
  --message "<delegation brief>" \
  --notify <subscriber-agent-name-or-thread-id>
```

List saved subscriptions:

```bash
t3-thread subscriptions
t3-thread subscriptions --subscriber <agent>
```

Remove a saved subscription for the calling T3 thread:

```bash
t3-thread unsubscribe --watch <agent>
```

Current scope note:

- `subscribe` / `unsubscribe` manage local routing state.
- `subscribe` rejects self-subscriptions so a coordinator thread cannot watch itself.
- `watch` polls the current snapshot-backed deployment in two phases: detection persists deduplicated notification events, then delivery claims pending events and attempts routed sends.
- Normal deployment: the launchd user agent `network.homenetwork.t3-watcher` keeps `t3-thread watch --interval 5` running (plist at `~/Library/LaunchAgents/network.homenetwork.t3-watcher.plist`, log at `~/Library/Logs/t3-watcher.log`). The manual commands below are for ad hoc debugging — routine use does not require the operator to run the watcher.

Run one watcher scan:

```bash
t3-thread watch --once
t3-thread watch --once --no-deliver
```

Run the watcher continuously:

```bash
t3-thread watch --interval 5
```

Inspect routed notification events:

```bash
t3-thread notifications
t3-thread notifications --subscriber <agent>
t3-thread notifications --source <agent>
t3-thread notifications --status pending
```

Explicitly acknowledge the latest assistant message:

```bash
t3-thread ack <agent>
```

Cleanup rule:

- When a stale thread should be retired, use `t3-thread archive` first when the remote thread is still active/completed but not yet archived.
- Then use `t3-thread forget` to remove the local saved mapping and any related local routing state.
- Do not hand-edit `~/.config/t3-remote-agents/state.json` for routine thread cleanup.

Interrupt a running thread:

```bash
t3-thread interrupt <agent>
```

List all threads for an environment:

```bash
t3-thread threads --env <environment>
```

## Replacing A Failed Thread

If a delegated thread is dead or attached to the wrong checkout, do not keep using it.

Recommended recovery:

1. Inspect the status and work log:
   - `t3-thread status <agent>`
   - `t3-thread worklog <agent> --tail 10`
2. Create a replacement thread with the same saved agent name, explicitly pinned to the correct branch:
   - `t3-thread create --name <agent> ... --branch <branch> ...`
   - `t3-thread create` sends T3's native `thread.turn.start` bootstrap command. T3 prepares and records the worktree path. Use `--base-branch <name>` if the new worker branch should be based on something other than `main`.
3. The saved agent mapping is overwritten by name, so future lifecycle commands target the replacement thread.

This is the preferred recovery path for the two most common failures below.

## Common Failure Modes

### 1. `Timed out waiting for thread/start`

Symptoms:

- T3 UI banner shows `Timed out waiting for thread/start`
- `t3-thread status <name>` shows `session.status = "stopped"` with `lastError`
- `t3-thread worklog <name>` shows `provider.turn.start.failed` and/or `runtime.error`

What it means:

- The provider adapter session did not start successfully for the delegated thread.

What to do:

1. Check `t3-thread worklog <name>`.
2. If the thread was launched without branch binding, replace it with a branch-pinned thread.
3. If the thread was already branch-pinned and still fails, treat it as a provider/runtime startup problem on that T3 environment and create a fresh replacement thread after the local T3/Codex side is healthy.

### 2. Thread Started On The Wrong Checkout

Symptoms:

- The T3 UI shows `Current checkout: main` or another unexpected branch.
- The delegated thread is pointing at the environment default checkout instead of the intended feature branch.

Cause:

- The thread was created without `--branch`, or the branch value was wrong.

Fix:

1. Stop using that thread.
2. Create a replacement thread with explicit `--branch`.

## Renewal Guidance

This repo does **not** implement automatic bearer-token renewal.

Current observed auth shape:

- bootstrap: `/api/auth/bootstrap/bearer`
- websocket token issuance: `/api/auth/ws-token`
- no separate bearer-session refresh endpoint confirmed yet

Operational renewal path for now:

1. Mint a fresh pairing credential on the target machine.
2. Run `pair` again for the saved environment.
3. Replace the stored bearer token in `~/.config/t3-remote-agents/state.json`.

Examples:

- local machine: generate a new pairing credential locally, then re-pair against the local server URL
- remote machine: generate a new pairing credential over SSH, then re-pair locally

Do not implement a custom renewal mechanism unless T3 exposes a first-class API for it.

## Coordination Hygiene

Keep [docs/ACTIVE_COORDINATION.md](/Users/brad/Programming/t3-thread/docs/ACTIVE_COORDINATION.md) current when:

- a new user request changes the active focus
- a new delegated thread is created
- an agent is replaced, retired, or promoted to active work
- a project changes phase (planned, running, awaiting review, deployed)

Minimum updates:

- active environments if they change
- active or recently important agents
- current task summary
- latest user request / next action

## Fresh-Agent Validation

When validating that a fresh agent can discover and use this repo:

1. launch a fresh full-agent subagent in this repo
2. ask it to orient itself using repo-local docs only
3. have it perform read-only lifecycle checks such as `envs`, `projects --env ...`, `t3-thread status <name>`, and command construction for a branch-pinned `t3-thread create` flow

Important caveat:

- Do **not** use the stripped-down `subagents --backend opencode ...` one-shot path for this validation. That harness is intentionally tool-stripped and may fail the test for reasons unrelated to the repo docs. Use a full agent backend instead.
