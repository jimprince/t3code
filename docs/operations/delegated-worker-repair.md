# Repair older delegated workers

Older app-owned delegates may lack organizational metadata or carry their owner's pin,
ordering, and automatic-settlement opt-out. The repair keeps IDs, task results,
execution ancestry, history, and explicit organizational edits.

Use the installed `t3` binary matching the release. The headless executable and
server bin bundled with desktop both include `repair-delegated-workers`.
`--base-dir` (or `--home-dir`) selects the environment home; `T3CODE_HOME` and
the server default home are respected. The command uses the server's V2 path
derivation, including development state when no explicit home is supplied.
`--database` can instead select a consistent snapshot. Never substitute the legacy
`state.sqlite` for the live V2 database.
The server can stay running:

```bash
t3 repair-delegated-workers --base-dir /path/to/environment-home
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
no operator RPC; this command uses its normal nesting and event-write services directly.
Direct application requires a maintenance hold: stop the owning server and hold
service, updater and cutover restart sources for the entire backup/apply/readback
window. A one-time offline check does not replace that operational hold. Stop it,
then run against that environment's database and retain stdout as the repair receipt:

```bash
t3 repair-delegated-workers --base-dir /path/to/environment-home --port <configured-port> --apply --offline > repair-receipt.json
```

Dry-run is the default (`--dry-run` is also accepted); application requires both
`--apply` and `--offline`. It refuses a listener on the configured port or any
holder of the main database, WAL or SHM (Linux `/proc`, macOS `lsof`). Inspection
errors, including permission gaps, refuse application; use an approved privileged
operator route. Supply the actual configured port, or it is read from the saved
server-runtime record/environment. Missing port information refuses application.
Take a stopped-state backup before applying and retain it through readback; do not
re-arm stale cutover jobs. It re-audits candidates, uses versioned command receipts
and the normal nesting service, and records field corrections as replayable native
metadata events. An interrupted or repeated pass preserves subsequent explicit edits.
The receipt lists applied IDs and the remaining manifest; an empty `changes` list is
the completion check. A nonempty `review` list still needs an owner decision.

Restart the server after application. The existing worker completion sweep settles
eligible successful workers bottom-up. Active, queued, held, failed, interrupted,
waiting, pinned, and explicitly opted-out work stays available. No thread is archived
or deleted by the repair.
