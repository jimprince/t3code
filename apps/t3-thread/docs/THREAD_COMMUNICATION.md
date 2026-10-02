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

Worker start prompts include their real ID, saved name, environment, project and parent reply command. Inter-thread sends and watcher notices identify their sender and include a reply command; queued sends preserve one header.

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
stop optional routed notifications from a worker, use
`t3-thread agent unsubscribe --watch <name>`. Settled recipients hold ordinary notices until
unsettled; a nested child’s question or approval wakes its parent at the next turn boundary. Repeated identical errors produce one notice; their accumulated count
is available through `t3-thread notifications` until the source state or reason changes.

Workers can end their final response with the exact line `T3_NOTIFY: quiet` to
suppress their own completion notice, or `T3_NOTIFY: attention` to flag a result.
Neither line suppresses required escalations. Omitting the line preserves the
usual behavior. Successful direct sends, including accepted queued sends, deduplicate
only the matching subscriber and turn; `all` explicitly opts into both notices.

## Reaching the user from a worker-started turn

Notices and sends from your workers carry their origin, and the app folds the
turns they start out of the user's default view. When such a turn needs the
user, ask through your provider's structured question or approval tool, or end
the final response with the exact line `T3_NOTIFY: attention`; either keeps the
turn visible. A question written only in prose inside a folded turn can go
unseen. Turns started by the user's own messages never fold.

## First-delivery guide

Ordinary watcher notices end with one line of commands to change or stop that
worker’s subscription. Child-input notices omit those controls because a parent’s
responsibility continues without a subscription.

A one-line guide link appears once per subscriber across all workers. Only a confirmed
successful notification delivery consumes it, so retries, held notices and filtered
completions do not. The receipt is saved in notification history, survives watcher
restarts and unsubscribe/resubscribe, and is retained when errors are recounted.
Existing subscribers receive it on their next successful delivery after upgrading.
Deleting the subscriber's local notification history resets this onboarding receipt.
See [Agent operations](AGENT_OPERATIONS.md) for pairing, lookup and watcher recovery.

## Waiting-child reminders

A nested child's pending question or approval always reaches its current parent,
including UI-created children, moved children and children without a saved subscription.
Existing subscriptions retain their preferences. The watcher sends an initial notice
and one reminder after 20 minutes if the request is still pending; it never repeats
that reminder, including after watcher restart. Change the delay with
`t3-thread subscribe --watch <name> --input-reminder-minutes <minutes>` or the same
option at creation. Zero disables the reminder and preserves the initial notice.
Answering, settling, archiving or unnesting the child cancels pending reminders.
Removing a subscription does not remove the parent's responsibility; unnest the
child to remove that implicit route. A busy parent receives the notice at its turn
boundary; a settled parent is woken. Remote parents are routed using `remoteParent.environmentId`, the stable server
descriptor ID, mapped to your saved environment alias. Missing pairings or expired
credentials appear as blocked in `t3-thread notifications`; pairing that descriptor
releases the notice even under a new alias. Changing either remote parent ID cancels
the old pending reminder. Remote nesting requires servers with the
`remoteThreadNesting` capability.

The parent should answer or approve when it can, or route the request to the chief
of staff when available. Otherwise ask Brad with the structured question tool or
end the final response with `T3_NOTIFY: attention` to put it in Brad's Needs you.

For a worker that should still be actively working, opt into one alert per
silence episode with `t3-thread subscribe --watch <source> --level attention
--inactivity-minutes 15`. Tool progress and reasoning count as activity. Completed
workers and those waiting for input or quota are excluded. Use
`--inactivity-minutes 0` to disable it. See
[Active-worker inactivity monitoring](AGENT_OPERATIONS.md#active-worker-inactivity-monitoring)
for restart, network, and silent-tool limits.
