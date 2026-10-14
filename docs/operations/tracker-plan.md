# Tracker Plan migration

The tracker becomes a project's Plan only after its head explicitly cuts over.
Until then, an unflagged briefing file continues supplying that project's Plan.
Creating an epic alone never changes the source. This prevents a partial
migration from hiding existing work.

After moving the work and verifying the tracker read-back, add `"source":
"tracker"` to the head's existing `~/.local/share/briefing/tasks/<head>.json`.
The same file must carry `"rootThreadId": "<owning-root-id>"` before the flag can cut over. Legacy unflagged files
bind only when their title uniquely matches an active root. Sharing
one repository does not combine two heads. A missing or unmatched file never selects the tracker. A flagged unbound file
produces a migration warning and no duplicate project. An unflagged unbound file
keeps its own head project without a warning. JSON roots retain linked
issue and thread progress, using the legacy labelled-epic and canonical-parent
rules. Inferred checklist workstreams apply after tracker cutover; a cross-root
JSON row stays with its JSON owner. The dashboard persists cutover with its snapshot; a tracker outage,
file disappearance or last-epic closure does not restore the old JSON. A flagged
file supplies only its binding and flag, never linked overrides or orphan rows.
Once that binding is cached, refresh does not read its task payload again.
Removed orphan rows are recorded as migration discontinuity; linked issue ids
stay stable.

A workstream is an open epic or an open issue with canonical children or a child
checklist. A child's first content line `Part of #N` wins over parent checklists;
a preceding T3 publication marker is allowed. Ambiguous checklist parents,
cycles and missing parents are reported. A nested epic contributes one child to
its parent's summary and has its own header, rather than another task-step bar.
Missing unticked children remain unknown in the denominator. Empty epics remain
headings with no measured progress. Header links retain access to the epic and
its execution thread. Snapshot compaction gives decisions priority and reports
workstreams omitted by the wire budget.

Personal steps come from unfenced, unquoted body checkboxes. Without a checklist,
open/closed tasks contribute zero/one to a one-unit count; open tasks have no
visible step bar. Checklist completion never closes an ask. Only genuine issue
closure supplies a finished outcome, retained in the existing 24-hour window.

Only `Progress: ` comments confirm owner progress. An explicit `next:` supplies
the next action; otherwise the first unticked personal step does. Stage-only
notes are status, not invented actions. Due dates retain calendar-day precision;
a time belongs in `next:` text. Rank and placed-by use the request-order parser
and never advance progress clocks. Stable step/child identities and persisted
samples make replacement plans distinguishable from movement. First observations
without confirmation are explicitly unknown, rather than dated from issue edits.

Repository note reads share the 30-second cache and a single in-flight read.
Initial backfill reads at most forty 50-comment pages per refresh; incremental
reads use the persisted updated-time cursor with three seconds of overlap and
at most four pages. A completed cursor never advances past the start of its scan, so edits during
pagination remain inside the next read. Incomplete ranges persist their continuation and never
replace the last complete notes. DashboardStore owns
`<stateDir>/dashboard-tracker-notes.json`, so cursors and notes survive restart.
Partial coverage and outages are exposed in source receipts; cached notes and
tracker rows survive failures. Open membership reads page to completion with a
5,000-issue bound; reaching it without a terminal page fails the repository read rather than shrinking
workstream counts. There is no per-task comment
request in dashboard refresh. Bodies are parsed up to64KiB and action text is
limited to500characters; truncated bodies are reported rather than treated as
complete checklists. Local file plans and Resume continue independently
of this migration.

Cutover is sticky. A deliberate rollback requires the owning head to prepare
its unflagged JSON, stop that host's server, back up its dashboard-snapshot.json,
and remove only the root id from trackerRoots in that snapshot before restarting.
Keep the issue samples and other roots. Removing a flag alone does not roll back
a cached tracker root. This procedure is operator-owned; workers never edit live
state as part of verification.
