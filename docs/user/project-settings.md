# Settings and project overrides

On web and desktop, the "Applying settings for …" sentence at the top of Settings pages picks
the project and environment a change applies to. Pages that only hold device preferences, such as
Appearance, don't show it. They start at **All projects** and **All environments**
and stay selected as you move between categories or search for a setting.

Preferences saved on this device, such as appearance, confirmations and browser profiles, always
show and ignore the selection. Everything else is stored on a server. Choose one environment to
edit its settings, or leave **All environments** to edit every connected environment at once.
Offline environments keep their current values; this is a bulk edit, not a synced global default.

Choose a project to override settings for it on the selected environments. A layers icon beside
each server row's title shows where the value comes from: the built-in default, the environment,
or a project override. Click it to see that chain on every selected environment. An override can
be reset to inherit again. Settings that cannot be overridden by a project are shown read-only
while a project is selected.

When the selected environments disagree, the control shows **Mixed** in place of a value and the
layers icon turns amber. Picking a value applies it to every selected environment.

Changing an environment value never touches a project's own override. When projects override the
setting you are editing, the layers icon counts them and the chain lists each one with its value:
click a project to jump to it, or **Reset all** to make those projects follow the environment
again.

Providers and diagnostics are per machine: they show one environment at a time, the primary
one until you pick another. Every other setting fans out to the selection.

On mobile, open **Settings** and use the filter in its header to choose connected environments
and a project. The filter stays available in server-setting pages. With **All projects** selected,
the **Server settings** categories and auto-settle controls in **Thread behavior** edit the
selected environments' defaults. Choosing a project edits its overrides on the selected
environments. Use **Use defaults** in a page to remove that page's project overrides.
Open **Settings → Projects & threads → Overview** to rename the project across its selected
connected checkouts and see where those checkouts live.
Settings that are environment-wide stay read-only while a project is selected. When selected
targets disagree, a control shows **Mixed** until you choose one value. Appearance, keyboard,
and other phone-only settings ignore the filter.

## Worktree branch names

In **Settings → Source Control → Worktree branch naming**, choose a static prefix,
a model-selected semantic prefix such as `feat/` or `fix/`, or custom instructions
for the complete name. The static prefix defaults to `t3code/`; a trailing slash is
optional, and an empty prefix adds nothing. Invalid characters in a static prefix
are replaced with hyphens. Custom instructions are appended to
the naming prompt and can specify issue IDs, namespaces, and casing.

These settings apply to automatically named new worktree branches. Select a project
to override its environment defaults. Worktree directories keep their original names.
If generation fails, or a custom name is invalid or already taken, the temporary
branch name remains.

## Scheduled tasks on mobile

Open **Settings → Scheduled tasks** to create recurring tasks or manage existing
ones across your connected environments. Use the settings filter to narrow the
list by environment or project. Each task runs on the environment you choose,
using its project, model, and workspace settings. Fixed-time schedules use that
environment's time zone, which may differ from your phone's.

You can edit, pause, resume, run immediately, or delete a task from the list.
Leaving an edited form asks before discarding unsaved changes.
Tasks bound to a settled thread skip their checks and show **skipped: thread settled**.
Un-settle the thread to resume its next check; skipped checks do not build a backlog.
**Run now** always runs: it reopens a settled thread, like sending a message.

## Defaults and inheritance

General contains the model and workspace for new threads. Integrations controls agent browser
access. Source Control contains automatic pull, the default pull request merge method and text
generation. The same rows edit environment defaults or project overrides depending on the
project crumb.

The Project category, shown while a project is selected, holds the project's name, icon, actions,
checkouts and removal. Actions belong to a project: editing them creates the project's own list
on each selected environment, and reset returns to the environment's shared list. A project's
`t3.json` actions can be imported there.

Settings a repository can also declare in `t3.json`, such as the workspace for new threads,
resolve in one order: a project override, then the environment setting, then `t3.json`, then the
built-in default. Leave a setting on **Inherit** to let the next tier decide.
Browser access changes apply when an agent session next starts.

New worktrees initialize git submodules recursively. If that step is slow because the repository
declares many nested submodules, set **Submodules** in **Settings → General** (with the project
selected to override it there) to **Top level only** to stop at the ones the repository declares
itself, or **Skip** to leave them for a setup script. It resolves in the same order as the
workspace default: a `"worktreeSubmodules"` value in the `t3.json` of the branch being checked out
applies when the project and environment are both on **Inherit**.

## Storage cleanup

Open **Settings → Storage** to enable automatic cleanup on one machine or all connected
environments. Policies are off by default and run on the server at startup, when changed, and
hourly. Offline machines keep their existing policies.

Select a project to set **Automatic worktree cleanup** to **Inherit**, **Off**, or **Custom**.
Inherit follows each machine's rules; Off keeps that project's worktrees until you remove them
manually. Custom applies separate worktree rules to the selected project or checkout. Browser
captures and log retention remain machine-wide.

Worktrees can be removed after a chosen number of inactive days, after merging, or when they
have no commits beyond the default branch. Only T3-managed worktrees are eligible. Active
sessions, shared worktrees, uncommitted changes, and ignored files other than `node_modules`
prevent removal. Branches and thread history stay; starting another turn recreates the checkout.
Merge cleanup requires the commits to be included in the remote default branch, so squash merges
may need the inactivity rule instead.

Enable **Delete worktrees with deleted threads** to remove safe worktrees after their last
thread is deleted, including archived threads and worktrees left by earlier deletions. The
server waits for sessions and terminals to stop and retries skipped worktrees after restart.
Existing prompts for deleting a worktree manually remain available when this policy is off.

Browser captures and rotated logs have separate retention periods. Expired capture links stop
working. Current logs, message attachments, and browser profiles are kept.

## Project icons

Select the project and open Project to choose an icon, emoji, monogram, or image. The choice applies to
every checkout in the project group and appears on connected clients. Choose **Automatic** to let
T3 Code detect an icon again.

Choose **Monogram** in the icon picker to set one or two letters or numbers and a color.

When no image is found, web and desktop show a two-character monogram with a color
from the icon palette, derived from the saved project name. For example, `Nebula` becomes `NA`,
`Silver Orchard` becomes `SO`, and `M7 Forge` becomes `M7`.

## Keep the default branch current

In Source Control, enable **Automatically pull** to keep the default-branch checkout up to date
with its configured upstream. Choose an environment to set the default or a project to override it.
On mobile, use **Settings → Source control** to change selected environment defaults or project overrides.

T3 Code only pulls when it can fast-forward and the checkout has no changed files, untracked files,
or local commits. It skips checkouts on another branch or without an upstream. If a checkout has
local work, resolve it yourself before automatic pulls can resume.

For remote-based worktree creation, see [New worktrees from a remote branch](./worktrees.md).

## Timed automations

Add an automation from the project's Automations section. Choose hourly, daily,
weekly, or selected days (for example weekdays), write the prompt, and choose a
fresh thread for every run or an existing thread. Times use the saved timezone,
even when you connect from another device. On a Projects page, the target
defaults to that project's orchestrator.

The server must be running. After downtime, it runs the latest missed occurrence
once if it is within 24 hours; older occurrences are skipped. Each scheduled time
runs at most once. A busy target waits until its next turn boundary. An archived
or deleted target fails with a visible reason. Fresh threads use the project's
default provider, model, and permissions. Pause, edit, delete, or run an
automation immediately from the same section, and open recent runs to read their
output. Pausing stops future schedules; an already queued run remains queued.
Deleting removes the definition and skips runs that have not started.

### Scripts

A script is a named, reusable prompt, such as "review open pull requests", kept
in one project or shared by all projects. Run one by hand, or have an automation
run it on a schedule, with the `t3-thread script` and `t3-thread automation`
commands. A project script replaces a shared script of the same name in that
project. A run reads the script when it starts, so editing a script changes
future runs only. Cron schedules, script automations and dry runs (record what a
run would do without starting it) are available from the command line.

Every project starts with shared quality scripts: code-quality, performance,
dependencies, refactoring, ux-review, docs-currency, data-model-review and
dead-code. Each reports findings with evidence and a suggested action, and
proposes removals rather than making them.

A script's result mode says what a run does with its findings. `review` (the
default) files nothing and leaves the thread open so you can read it and tell the
agent what to follow up. `file-only` files each finding as a request.
`file-and-settle` files them and then settles the thread. Set the mode on the
script, or override it for one run. Every run links to the thread it started.
A paused timed automation also becomes a project script of the same name.

### Event triggers

An automation can also start when something happens, from `t3-thread automation
add --on <event>`: a pull request is linked to a thread in the project
(`pull-request.opened`), a linked pull request's checks start failing
(`ci.failed`), an issue in the owning orchestrator's repositories gets a label
(`issue.labeled`), a thread in the project waits for an approval or an answer or
its session fails (`worker.blocked`), or a GitHub repository publishes a release
(`release.published`, for example `pingdotgg/t3code`). Narrow a trigger with
`--repository`, `--label` or `--for-thread`.

Each new state fires once: a pull request whose checks keep failing does not
start another run until they pass and fail again. Labels and releases are checked
every five minutes, and ones that existed before the automation was watching do
not fire. The run's prompt ends with what happened and a link to it.
