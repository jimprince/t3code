# Moving Threads Between Machines

Right-click a thread in the sidebar and choose **Move to machine…**, then pick a connected environment with a project for the same repository. A running turn is interrupted first. The source is archived after the destination confirms a durable import. If the source changes during the move, both copies remain available.

Conversation history, metadata, available attachments and workspace changes travel with the thread. Attachments are limited to 50 MiB each and 64 MiB in total. Missing historical files retain their names and report a warning. A branch conflict offers a new worktree on `<branch>-moved-<thread-id-prefix>` without modifying the destination branch.

The destination starts a fresh provider session with a bounded handoff of the imported conversation. Historical tools, plans, goals, checkpoints and diffs remain readable as history. Historical checkpoints cannot restore files; only checkpoints created natively on the destination can restore its workspace.

Update older destination servers before moving a thread. Current servers read released version 1 and 2 bundles and export version 3 bundles. Live terminals and in-flight provider runtime do not move.
