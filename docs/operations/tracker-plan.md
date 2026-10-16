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
Refresh reads the bounded file and compares its SHA256 content hash; changed files
are decoded again, including after restart. Only the tracker header is decoded,
so legacy task payloads remain ignored. Read/decode failures retain the last
good tracker header and selection with a failed source receipt. The predecessor
list is optional and unknown header keys are ignored; a malformed
`predecessorRootThreadIds` value fails the whole header decode, retains the last
good selection, and marks the source failed.
Removed orphan rows are recorded as migration discontinuity; linked issue ids
stay stable.

For a head handover, normally edit the same briefing file: set the new
`rootThreadId` and append the old id to `predecessorRootThreadIds`, keeping any
earlier predecessors so the chain is flattened. Update these together:

```json
{
  "source": "tracker",
  "rootThreadId": "<new-head-id>",
  "predecessorRootThreadIds": ["<old-head-id>"],
  "head": "product",
  "title": "Product",
  "updated_utc": "2026-10-16T00:00:00Z"
}
```

The optional predecessor list transfers request-marker author/root IDs, issue
links, issue owners and resolved decision-waiting threads before exclusion and
ownership. Each successor also adopts the predecessor's own issue list, so links
and repositories discovered only through that head are retained. Refresh keeps
listing declared predecessors present in the shell snapshot, including settled
and archived heads. A predecessor no longer renders as a project or tracker root, even
when active, archived or settled. Stronger links to a narrower live project
continue to win. Historical headers can form a transitive chain ending at a
current root. A cycle, duplicate claim by separate files, or predecessor that
is itself a current root with its own flagged file is ignored and reported via
the migration-warning feed. Remove the old current flag when transferring its
identity; do not rewrite tracker issue bodies. An edited binding alone does not
clear the old sticky tracker selection: only an accepted predecessor declaration
does that. Administrative handover fences are independent of this header.

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

## Dashboard rendering

Task rows show personal steps (done/total with a bar). A task without a
checklist shows "no checklist yet": no bar, no 0/1, and it counts as an open
task, not as a step. A workstream header shows done/total child tasks with its
own bar; nested epics sit under their parent and are counted once there. A
header whose epic has no children is a heading with "no tasks yet". Child counts
and task steps are never added together. A due date shows as a calendar date
("Oct 20"), never a time. Membership warnings, workstreams left out of the
snapshot and rows dropped from a retired plan file each get one short line.
A first observation whose confirmation time is unknown is never dated.
A `source: tracker` briefing file that binds to no root shows once on Home as
"Unbound briefing file: <file> (<reason>)" (it never switches a root). A truncated plan body
shows "Plan body truncated" under its row. A checklist-less task shows its latest
note's `next:` text in place of "no checklist yet". An epic's own due date shows on
its header when the snapshot keeps the epic's task.

A task or workstream row shows one extra line, `Working: <thread> · 12m`, only while
a thread is working on it now: the thread holds an explicit link to the issue
(`request start`/`note`, launch with `--issue`, `link_gitea_issue`, or `delegate_task`
with `issue`), is not a project head (a head's links mean intake, including a
predecessor head resolved through `predecessorRootThreadIds`), and has a run that is
running, starting or queued. Each name opens that thread; at most two show, then `+N`.
Waiting on Brad stays in the existing badge; settled, idle and held threads never
show. The snapshot carries at most eight workers per row, recomputed locally on run
and link changes with no tracker or provider read. A running thread linked to two
items shows on both. When more threads work on a row than the snapshot carries (eight), `+N`
counts from the true total, and over budget a row being worked is kept ahead of an idle one.
A thread's own current links decide whether it shows, so an unlink hides it at once; the
cached tracker rows speak only for servers that do not report shell links. A link made by
`delegate_task` with `issue` has role `worker`: it shows the child but is ignored when the
snapshot picks the owning project, keeps no item listed on its own (a settled or archived worker never hides an open item) and adds no repository to the delegating head's discovery; every other link keeps deciding ownership as before. Kept rows keep their snapshot order when the budget trims rows. Links stored before delegated children stopped inheriting their
parent's issues still count when the thread is running.
A handover warning shows its own reason ("t3-product.json: predecessor c7da3448 is
claimed by more than one file (ignored)"), one line per distinct warning.
