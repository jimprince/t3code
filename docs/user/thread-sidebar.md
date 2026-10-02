# Working with threads

Use a new thread for a separate task. Choose **New worktree** when its code changes
need a separate branch and working directory.

## Start a thread

On web and desktop, a new thread keeps the current project and carries your model
and mode selections, unless the destination project has its own model default.
With no thread open, it starts in the project you last messaged.
Its branch and workspace mode come from your configured defaults. To continue in
an existing worktree, use **New thread in this worktree** from the branch toolbar.

When you change a new thread's project, T3 Code stays in the current environment
if that project exists there. Otherwise it selects an environment that has it.

### Start without a project

A thread does not need a project. To start one without a project, click **or
start without a project** under a new thread's heading, pick **No project** from
the project menu in that heading or from **New thread in...** in the command
palette, or press `mod+alt+n`. On mobile, pick **No project** from the project
list. To move a draft into a project, pick the project in the heading.

Each thread without a project works in its own folder under `~/.t3/scratch` (the
`scratch` folder of your T3 data directory), named after its date, the first words
of its first message, and a short id, like
`2026-09-25-convert-these-pngs-to-webp-a1b2c3d4`. Deleting a thread keeps its
folder, so the files the agent wrote stay until you delete them. Branch, worktree, and diff controls stay hidden because
these folders are not Git repositories. This is unavailable when the data
directory itself sits inside a Git checkout.

### Start in the background

In a desktop browser or the desktop app, press `Cmd+Enter` on macOS or `Ctrl+Enter`
on Windows and Linux to start a new thread and immediately open another draft. The
next draft keeps the workspace mode and base branch you selected. With **New
worktree**, each background submission creates its own worktree.

To send the same prompt to several models on web or desktop, **Shift-click** models
in a new thread's model picker to add or remove them. A regular click returns to a
single model. Choose a base branch and send. Each selection starts a separate thread
and worktree while you stay in the new thread composer. This requires a Git project.

## Pin and reorder threads

Pin a thread from its menu to keep it above your active work.

On web and desktop, unpinning, settling, snoozing, and archiving a thread each show
a notification with **Undo** for five seconds. Undo restores the thread's previous
state, including its pinned position, and reopens an archived thread you were
viewing. `mod+z` triggers the most recent Undo when no text field is focused; see
[Keybindings](./keybindings.md#commands-with-special-behavior).

On web and desktop, you can also drag files from your computer onto any thread row:
the thread opens and the files are attached in its composer, ready for
your next message. The same per-message file limits apply as when attaching
files directly; see [Attach files](./composer.md#attach-files).

On web and desktop, pinning or unpinning a thread keeps the sidebar at your current
scroll position instead of following the thread to its new place in the list.

Pinning does not prevent automatic settlement, which keeps the pin. Manually
settling a thread removes its pin. Pinned threads are protected from automatic archive.

On web and desktop, drag a thread between sections to change its state. Drag a thread up into
the pinned section to pin it at the spot you drop it; drag a pinned thread down into the active
list to unpin it. Dragging a thread onto the **Settled** header settles it, and dragging a settled
thread into the active list un-settles it. A snoozed thread can be dragged out of the snoozed
shelf, which wakes it, but threads cannot be dragged into the shelf because snoozing needs a wake
time. Dragging a pinned thread out of the pinned section does not ask for unpin confirmation.
Pinned and active boundary labels appear only while dragging, without moving the rows. The
other rows slide aside to show where the thread will land. When you cross into another section,
the dragged thread shows the action the drop performs, with its icon: **Pin**, **Unpin**,
**Settle**, **Un-settle**, or **Wake**. Its status and hover actions hide during the drag. A pinned
thread keeps its pin only while it stays in the pinned section; once it leaves, the badge takes
over. Reordering within the same section shows no badge. When there are no pins, drag to the top
edge to pin a thread. Section labels stay readable for the whole drag, and the section the
thread is over takes the accent color. Section labels also
identify empty sections and a collapsed settled shelf.

Drag within the pinned or active section to change its order. Other rows slide aside to show the
spot where the thread will land. Drops into either section keep the position you choose. On
mobile, open a thread's menu and choose **Arrange threads**. Drag a handle within or between
**Pinned** and **Active** to reorder, pin, or unpin. Drop onto the **Settled** divider to
settle a thread. The dragged card shows the action before you release it. Expand **Snoozed**
or **Settled** to drag a parked thread back into either live section. Each drop saves; **Done** returns to the thread list.
**Move up** and **Move down** are also available in the thread menu. The server
saves the order, so it survives a refresh and appears on your other connected devices.

On web and desktop, the list also animates section changes made with thread actions such as
**Pin**, **Settle**, and **Snooze**. These transitions respect your system's reduced-motion
preference. While dragging, rows follow the insertion gap without replaying a second transition
after the drop.

New threads appear above the active threads you have arranged. Settling clears a thread's active
position, so using **Un-settle** returns it to the top. Pinning and snoozing preserve its active
position until you move it again. Thread activity does not change the order. The settled shelf
continues to use settlement time.

If dragging is unavailable for one environment, update the T3 Code server running in that
environment. Pinned and active reordering require server support. Threads from older servers keep
their default order until the server is updated.

### Fold working threads (beta)

On web and desktop, turn on **Settings → General → Working section (beta)** to move threads that
are working or monitoring into a collapsed **Working** section at the bottom of the sidebar. A
thread returns to the top of the active list when it finishes, fails, or needs an approval or
answer. Pinned threads stay in the pinned section.

While this is on, the active list is ordered by when each thread last came back to you, so you
cannot drag to reorder it. Your saved order returns when you turn it off.

## Settle finished work

When a thread has notification subscriptions stored on its environment, settling
shows the source threads and offers to remove those subscriptions. Keep them to
hold notifications until you un-settle; remove them to stop future delivery.
You can restore the removed routes from the confirmation. Routes managed on
another operator machine must be changed there.

Choose **Settle thread** from its menu to move finished work out of the active list
without deleting the conversation. **Un-settle thread** restores it to active work
and prevents automatic settlement until new activity resumes the usual rules.
Manually settling an idle thread dismisses unanswered async questions without
sending an answer or restarting the agent. Settling also closes the thread's
terminals that wait at an idle prompt, and keeps their output. A terminal that
runs a command, such as a dev server, stays open.

Agent-created workers settle when a turn completes without pending input or approvals.
UI-created top-level threads keep their usual settlement rules. Change the project default
with **Settle completed workers** in **Thread behavior**; a worker can override it at creation.
The thread's **Auto-settle behavior: Disabled** overrides completion settlement too.
A follow-up resumes a settled worker automatically.

Settled subthreads archive after seven days by default. **Archive settled subthreads**
and its days setting can be changed per environment or project in **Thread behavior**.
Disable the setting to retain them indefinitely. Restoring a settled thread or making
a later change starts a fresh archive recovery window. Pinned threads, threads with automatic
settlement disabled, and threads with active descendants never auto-archive. Restore a
conversation through the existing archive; worktree cleanup may separately reclaim its
checkout after the recovery window.

By default, environments settle inactive threads after three days and settle
threads whose pull request merged. A closed pull request can also settle an idle
thread. Work in progress, pending questions or approvals, and live background work
prevent automatic settlement. An open pull request does not prevent inactivity
settlement, but an old closed or merged pull request does not settle work you
resumed after it closed.

To keep one thread out of the settled shelf no matter how long it sits idle, open its menu,
choose **Auto-settle behavior**, and pick **Disabled**. The current option is checked. Pick
**Enabled** to return to the usual rules. Manual settle, snooze, and archive still work while it
is disabled.

Change these rules in **Settings → General** on web and desktop, or **Settings → Thread behavior** on mobile.
They continue to run when your apps are closed. On web and desktop, choose an environment at the
top to change only its rules, or **All environments** to update connected environments together.
Mixed values show where the selected environments disagree. Mobile applies these
rules to connected environments that support shared settings. Offline environments
and older servers keep their previous values. Changing a rule does not reopen
already settled threads.

## Link a pull request

The server finds the PR for each unsettled thread's saved branch, even when your
apps are closed. Settled threads keep their saved links. Update the server if
automatic branch links do not appear.

On web and desktop, right-click a pull request link in a thread and choose
**Link to thread** to select a different PR. Use **Unlink from thread** on the
same link to return to the branch PR, if one exists.
The linked pull request participates in automatic settlement.

## Find and reference work

On web and desktop, open the command palette with `Cmd/Ctrl+K` to search threads
across connected environments. Message search starts after two characters and
includes your messages and final agent responses.

Use **Settings → Keybindings** to find or customize shortcuts for searching files
and copying a thread reference. A copied reference uses the thread's pull request
link when available, otherwise its thread ID. See [keybindings](./keybindings.md)
for custom configuration.

## Inspect agent work

On web and desktop, use **Agents** to follow work delegated to subagents.

Expand a tool call in the conversation to see its full command and output.
Summaries shorten shell wrappers and can still describe the latest call after it
finishes; the call's own result shows its status.

### Nest threads under an orchestrator

A thread can live under another thread instead of in the sidebar. Nested threads
appear in the parent's **Agents** panel alongside its subagents, in the order
they started, with their status; click one to open it. While a nested thread is
open, it shows in the sidebar under its parent, and the header breadcrumb names
the parent; click it to go back. Agents that start worker threads with
`t3-thread` nest them under their own thread by default.

Settled work folds into a collapsed **Settled** shelf at the bottom of the
Agents panel: nested threads that are settled, including by automatic
settlement, and subagents or workflows that have finished. Something that
finishes while you are watching stays where it is until you next open the
panel. A `t3-thread` worker settles after a completed turn by default when
no input or approval is pending. Its parent can send a follow-up to resume it.

To nest a thread yourself, open its menu in the sidebar and choose **Nest
under…**. To bring one back, choose **Move to sidebar** from its row in the
Agents panel or from the thread's own menu. **New thread under this one** in a
thread's menu starts a thread that is nested from the start.

On web and desktop, dragging a sidebar thread reorders it by default. While the
pointer is over another thread row, move right by one child indent to nest it.
The highlighted parent and indented marker show a nesting drop; move back left
to restore the full-width reorder marker. Nesting preserves the dragged thread's
pin state. Dropping into the top-level **Pinned** or active section moves a nested
thread back to the sidebar and pins or unpins it to match that section. Nested
threads can also be reordered among siblings with the same pin state.

Nesting can continue through multiple levels within an environment and can span
projects. A child keeps its own repository, worktree, branch, and model defaults.
Cross-project children appear under their parent in the sidebar with their project
label when its agent list is expanded. Project filters apply to each thread's own project. If the parent is hidden,
filtered out, archived, or removed, the child appears at top level in its own
project. Removing the parent's project does not delete children from other projects.
Pin a nested thread from its sidebar menu to keep it visible under its parent when
the parent is collapsed and first among its siblings when expanded. It stays out of
the top-level **Pinned** section; unpin it to restore normal collapse behavior.
Archiving or settling a parent does not archive or settle its children. An idle
parent shows **Supervising** while any descendant is working or needs input; its
separate child-attention marker still identifies questions that need an answer.
Settled parents keep their settled presentation. An orchestrating agent is expected
to answer its workers itself and ask you only when it cannot. Nesting is not
available in the mobile app yet; mobile lists every thread and uses the same
**Supervising** status for an idle parent with active descendants.

Nested threads in the Agents panel show their latest output, model and effort,
provider pool, tokens and tools when available, turn duration, last activity and
workspace. A project badge identifies workers in a different project. Token
counts labeled `ctx tok` describe occupied context when the provider does not
report a cumulative processed-token count.

### Focus on what needs you

An orchestrating thread receives a lot of traffic from its workers: completion
notices and results sent with `t3-thread`. In an orchestrator, turns started by
that traffic fold into one **N background turns** row, so your own messages, the
agent's replies to you and anything that asks for you stay readable. A worker
turn stays visible when it raised an approval or a question, or when the agent
ended it with the line `T3_NOTIFY: attention`; a folded turn that later raises
one reappears on its own. Messages from the thread's parent or from other
threads that are not its workers never fold.

Click a folded row to read those turns in place. To see every turn, switch the
bar above the conversation from **Brad view** to **All traffic**; the count next
to it says how many worker turns asked for you since your last message. On
mobile, folded rows expand on tap; the switch and the count are web and desktop
only.

## Snooze until later

Choose **Snooze → Custom…** from a thread's menu to pick a date and time in your
local time zone, or a duration in minutes, hours, or days. Durations start when
you confirm; one day means 24 hours. On web and desktop, you can also snooze
several selected threads together. Choose **Wake thread** to bring a thread back early.
