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

A nested worker's unanswered question is sent again to its subscribed parent every
45 minutes after the last confirmed delivery, with the question and choices.
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
