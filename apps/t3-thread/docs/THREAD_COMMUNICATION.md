# Communicating with T3 workers

Attention notifications are automatic watcher messages about a worker, routed
through your subscription. They contain its name, state, reason and a short
output preview. Run `t3-thread result <name>` for the full latest turn output;
`--final-message` returns just the last assistant message.

## Reply, unblock, finish

- Give feedback or more work: `t3-thread send <name> "message"`. A send to a busy
  worker queues until its turn ends. `t3-thread queue <name> --open` lists pending
  sends; `t3-thread dequeue <id>` cancels one that has not dispatched.
- Inspect questions and approvals: `t3-thread pending <name>`.
- Answer a single question: `t3-thread answer <name> "answer"`. For multiple
  questions, repeat `--question <id=answer>` using the IDs from `pending`.
- Resolve the oldest approval: `t3-thread approve <name>` or `t3-thread deny <name>`.
  Do not substitute an ordinary send for a pending question or approval response.
- Finish a worker: `t3-thread settle <name>`. `t3-thread unsettle <name>` reopens it;
  sending new work also resumes it. Settling yourself requires `--self`.

## Choose notifications

When creating a worker, choose `--notify-level all|attention|none`. To change an
existing subscription from your own thread, run
`t3-thread agent subscribe --watch <name> --level attention` (substitute your level).

- `all` is the default, including for existing subscriptions. It includes ordinary
  completion notices even when the worker sent you a direct result during that turn.
- `attention` is recommended for supervisors receiving direct results. It delivers
  interruptions and escalations. A completion needs the worker's explicit
  `T3_NOTIFY: attention` final line and is suppressed if it already sent you a
  direct message during the same turn.
- `none` suppresses ordinary completions and interruptions.

Questions, approvals, plan review and errors always pass all three levels. To
stop all routed notifications from a worker, use
`t3-thread agent unsubscribe --watch <name>`. Settled recipients hold notices until
unsettled. Repeated identical errors produce one notice; their accumulated count
is available through `t3-thread notifications` until the source state or reason changes.

Workers can end their final response with the exact line `T3_NOTIFY: quiet` to
suppress their own completion notice, or `T3_NOTIFY: attention` to flag a result.
Neither line suppresses required escalations. Omitting the line preserves the
usual behavior. Successful direct sends, including accepted queued sends, deduplicate
only the matching subscriber and turn; `all` explicitly opts into both notices.

## First-delivery guide

The short guide appears once per subscriber across all workers. Only a confirmed
successful notification delivery consumes it, so retries, held notices and filtered
completions do not. The receipt is saved in notification history, survives watcher
restarts and unsubscribe/resubscribe, and is retained when errors are recounted.
Existing subscribers receive it on their next successful delivery after upgrading.
Deleting the subscriber's local notification history resets this onboarding receipt.
See [Agent operations](AGENT_OPERATIONS.md) for pairing, lookup and watcher recovery.

## Waiting-child reminders

A nested worker's unanswered question is sent once more to its subscribed parent
20 minutes after the initial confirmed delivery, with the question and choices.
Change a route with `t3-thread subscribe --watch <name> --input-reminder-minutes 20`,
or choose the interval at creation using `--input-reminder-minutes 20`.
Zero disables reminders while preserving the initial input notification. All
notification levels still deliver input escalations. The interval and delivery
history survive watcher restart. Answering, settling, archiving or unnesting the
worker stops reminders; unsubscribe also removes the route. A busy or settled
parent retains the latest pending notice under the usual delivery rules.

For a worker that should still be actively working, opt into one alert per
silence episode with `t3-thread subscribe --watch <source> --level attention
--inactivity-minutes 15`. Tool progress and reasoning count as activity. Completed
workers and those waiting for input or quota are excluded. Use
`--inactivity-minutes 0` to disable it. See
[Active-worker inactivity monitoring](AGENT_OPERATIONS.md#active-worker-inactivity-monitoring)
for restart, network, and silent-tool limits.

## Reliable V2 handoffs and receipts

`send` uses server admission instead of waiting locally for every running turn.
Codex receives ordinary handoffs through native active steering; Claude receives
SDK `next` priority at the next tool boundary. Explicit `--control` uses immediate
steering and can interrupt tools. Unsupported safe steering queues natively.
`--progress` / `--coalesce <key>` queue replaceable progress behind active work;
new accepted progress supersedes only that authenticated sender's pending entries
with the same sender-thread provenance, recipient and key. Dispatched history is
retained. `--no-queue` refuses an active recipient with `BUSY`.

Generate and durably save a send ID in your own automation before launching the
CLI, then pass `--send-id <id>`. The CLI independently fsyncs a private intent
record before transport. Intent files contain recipient, environment, timestamp,
coalesce key and a payload/provenance hash, never the message body. A generated
CLI ID is also durable before transport, but callers whose subprocess output can
be lost should supply their own ID so they already know the recovery key.

The server binds each ID to its authenticated sender, recipient and payload,
and commits the receipt with native events and outbox before provider work.
Receipts describe durable admission (`started`, `steered`, `queued`, `held`,
`refused`, `superseded`, `cancelled`), not proof that an agent read the message.
Settled recipients are held even for control sends; confirmed selected-provider
quota exhaustion is refused with `QUOTA_EXHAUSTED` and an owner thread reference.
Neither refusal nor uncertainty switches providers/accounts or wakes an owner.
Held messages retain their private pending payload. Unsettling the thread from
any client (web, mobile, MCP or CLI) makes the server replay them oldest first
under their original send IDs; quota refusals require an explicit send.

Timeout, OS transport failure and interruption return fixed sanitized cause codes
and `uncertain: true` when transport might already have accepted the message.
That outcome does not authorize automatic retry, a fresh ID, provider fallback,
or recipient wake. Use `send-receipt <recipient> <id>` to read the receipt without
resending. An explicitly requested same-ID retry is idempotent only with the
identical recipient, payload and provenance; changed input returns `SEND_ID_CONFLICT`.
A failed/uncertain send exits with code 2. A server lacking receipt support is
refused with `RECEIPTS_UNAVAILABLE` instead of silently reverting to unsafe sends.

Metadata lookup also supports `send-receipt <recipient> --coalesce <key>
--since <ISO> --until <ISO>` over at most 24 hours. It reports `found`, `unknown`
or `multiple`; it never infers which send a matching timestamp represents.
`own-inbox` makes one scoped receipt RPC using local caller/environment identity,
without scanning the fleet or hydrating transcripts. It exposes at most the latest
50 admissions and reports truncation. Exact and coalesce lookups are private to
the authenticated sender; inbox access follows the existing environment-wide
orchestration read scope, rather than claiming a new per-thread access boundary.
All responses exclude bodies, stderr, authentication identity and binding hashes.

Queryable receipt metadata has a 30-day horizon. ID bindings remain in existing
storage indefinitely to prevent reused IDs from acquiring a different payload;
`unknown` can mean never accepted or outside the lookup horizon. Coalesce results
are capped at 50 with an honest truncation flag. Historical sends made before this
protocol cannot be retroactively attributed from queue snapshots. The six disk
observer intents remain UNKNOWN.

Watcher crash recovery looks up the retained exact ID and never blindly resends a
stale claim. An absent or ambiguous receipt leaves the delivery uncertain. A known
native queued receipt needs no watcher wake; it drains through V2's native outbox.
Only locally held sends need the separately deployed per-machine watcher.

Live named-agent sends resolve the existing incarnation and use this same
receipted path. A dormant named agent is refused with `DORMANT`: automatic
incarnation through the older unreceipted resolve RPC is not protocol recovery.
Start an incarnation with its explicit named-agent lifecycle command first.

Receipt-backed sends require the **target server** to advertise `capabilities.reliableHandoffs=true`; updating only the sending CLI is insufficient. A `RECEIPTS_UNAVAILABLE` refusal includes the target version and environment. Update that environment through its supported app/server updater, confirm the capability in its descriptor, and retry with the same send ID. The refusal submits no message and never falls back to a send without receipts.
