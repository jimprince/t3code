# Repair older delegated workers

Older app-owned delegates may lack organizational metadata or carry their owner's pin,
ordering, and automatic-settlement opt-out. The repair keeps IDs, task results,
execution ancestry, history, and explicit organizational edits.

Inspect from a source checkout matching the installed release and its dependencies.
Point the dry-run at the environment database.
The server can stay running:

```bash
node apps/server/scripts/repair-delegated-workers.ts --database /path/to/statev2.sqlite
```

The script opens the source only through a read-only SQLite connection to produce a
consistent `VACUUM INTO` snapshot in a private temporary directory. It runs the full
repair against that writable copy, diffs before/after, then deletes the copy. No repair
layer is constructed against the source during dry-run. `changes` lists actual copy
changes, including organization and field resets, their before/after values, creation
event, verified owner, and event sequence. `wouldApply` lists the affected threads.
`review` lists records whose ownership or creation provenance could not be verified.
Existing metadata, including an explicit null parent, always wins. Pin/order/opt-out
resets require matching values in the child's creation event and its parent's earlier
history, with no later deliberate event for that field. Imported records without
creation provenance require separate review.

Deployment owns application after install and manifest review. The repair service has
no operator RPC; this script uses its normal nesting and event-write services directly.
Direct application requires the owning server stopped. Stop it,
then run against that environment's database and retain stdout as the repair receipt:

```bash
node apps/server/scripts/repair-delegated-workers.ts --database /path/to/statev2.sqlite --apply --offline > repair-receipt.json
```

Application requires both flags and refuses a database opened by another process
(Linux `/proc`, macOS `lsof`). It re-audits candidates, uses versioned command receipts
and the normal nesting service, and records field corrections as replayable native
metadata events. An interrupted or repeated pass preserves subsequent explicit edits.
The receipt lists applied IDs and the remaining manifest; an empty `changes` list is
the completion check. A nonempty `review` list still needs an owner decision.

Restart the server after application. The existing worker completion sweep settles
eligible successful workers bottom-up. Active, queued, held, failed, interrupted,
waiting, pinned, and explicitly opted-out work stays available. No thread is archived
or deleted by the repair.
