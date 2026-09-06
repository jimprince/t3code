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
  If the target clone is missing the base commits the thread is
  built on, the import automatically fetches the target's primary remote and
  retries; the move only fails if the commits are not on the shared remote
  either (push from the source, or pull on the target, then retry). If the
  thread's branch already exists on the target with different history or is
  checked out there (for example a thread working directly on `main`), the
  move asks whether to create a new worktree on a fallback branch named
  `<branch>-moved-<thread-id-prefix>` at the exported tip; the target's own
  branch is never modified.
- **Agent memory** — the Claude Code session transcript is copied
  under the target machine's `~/.claude/projects/<new-worktree>` directory and
  the resume cursor is preserved, so the next turn resumes with full native
  session context. The cursor is preserved only when its matching transcript
  is transferred successfully. When native provider context cannot be moved
  (including Codex sessions), T3 sends up to 64 KiB of the most recent visible
  message history as provider-only context with the first turn on the target.
  This handoff is not added as another visible message, is consumed only after
  the provider accepts the turn, and is not repeated on later turns. The move
  reports this fallback as a warning.

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
