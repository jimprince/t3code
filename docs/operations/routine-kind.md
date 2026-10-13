# Routine classification

Automations and scheduled tasks accept optional `routineKind`: `check`, `project`, or
`agent-wake`. An omitted value follows the owner thread's effective purpose:
Harness owners default to `check`, project owners to `project`, unknown owners to
`check`. Names never determine runtime classification. Older records need no migration.

`harness.snapshot` returns all routine kinds, including project routines. Every row
has `routineKind`, `routineKindSource` (`explicit` or `default`), and `ownerThreadId`.
The legacy `purpose` wire enum remains unchanged; `routineKind` owns classification.
Consumers show checks in Harness, project routines on project pages, and agent wake
routines under their owner's agent row. Check `harnessRoutineKind` in the environment
capabilities before exposing classification controls on an older server. Older snapshot
rows decode as default checks; this preserves existing read-only Harness views.

Pins override the filter only within Checks (`routineKind: check` or unclassified
rows). A pin on a `project` or `agent-wake` routine stays inert and cannot move that
routine into Checks.

`harness.routineKind.set` RPC and `harness_routine_kind_set` MCP tool take
`{routineKey, kind}`. Exact local automation/scheduled-task keys are editable. Feed and
legacy-only rows are read-only. Null clears the explicit kind for undo; the setter
returns null and `source: default`, and the next snapshot contains the resolved kind.
MCP read-only clients cannot write. Classification never dispatches or reschedules a run.

Automation kinds live in `automation_json`; scheduled-task kinds live beside timing
in the existing `schedule_json`. Schedule schemas still decode the timing alone. Older
editors and scheduler writes preserve the current explicit classification. Persisted
classification values participate in the snapshot cache key, including changes through
create/edit RPCs and changes from another server process sharing the database.

The operator CLI supports `automation add --routine-kind`, `harness snapshot`,
`harness tasks`, and `harness routine-kind-set <routine-key> <kind> --env <name>`
(use `default` to clear). `harness classify --env <name> --plan-file <file>` prints a
JSON dry-run table for a reviewed array of `{routineKey, name, kind}`. Add `--apply`
only after human review and `--undo-file <path>` to retain original classifications.
Each changed row is read back; repeated apply skips already-explicit matching kinds.
Replay undo entries through `harness routine-kind-set`, mapping null to `default`.
No live bulk classification is part of shipping the feature.
