# Moving Threads Between Machines

A thread can be moved from one execution environment (machine) to another, as
long as both environments have a project for the same repository (the sidebar
groups these into one row, e.g. "2 projects").

Right-click a thread in the sidebar and choose **Move to machine…**, then pick
the target environment. The client must be connected to both environments; it
exports a portable bundle from the source server and imports it into the
target server. If a turn is running, it is interrupted and the provider
session is stopped before export. The source thread is archived only after
the target confirms the import, so a failed move never loses the thread.

## What moves

- **Visible history** — messages, activities, proposed plans, goal, and
  checkpoint summaries are replayed into the target server's event log under
  the same thread id.
- **Git state** — the thread branch and its `refs/t3/checkpoints/*` refs
  travel as a thin git bundle; a new worktree is created in the target clone,
  and uncommitted tracked changes plus untracked files are restored into it.
  The target clone must already contain the commits the thread branch is
  based on (fetch/pull first if the move reports missing commits).
- **Agent memory (Claude)** — the Claude Code session transcript is copied
  under the target machine's `~/.claude/projects/<new-worktree>` directory and
  the resume cursor is preserved, so the next turn resumes with full native
  session context. Other providers currently move history only; the agent
  starts its next turn fresh (the move reports this as a warning).

## What does not move

- Live terminal sessions.
- An in-flight turn — the move quiesces the thread first.
- Image attachment blobs (message text and attachment names are kept).
- Checkpoints whose git refs no longer exist on the source (reported as a
  warning).

## Internals

`orchestration.exportThread` / `orchestration.importThread` WebSocket RPCs,
implemented in `apps/server/src/orchestration/Layers/ThreadTransfer.ts`. The
bundle format is the versioned `ThreadMoveBundle` in
`packages/contracts/src/orchestration.ts`; import replays the portable thread
through the internal `thread.import` command so projections and reactors need
no import-specific handling.
