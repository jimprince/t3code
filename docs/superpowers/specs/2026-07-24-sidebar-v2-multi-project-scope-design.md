# Sidebar V2: multi-project scope with isolate

Date: 2026-07-24
Status: approved, ready for implementation plan

## Problem

The Sidebar V2 project scope menu (`apps/web/src/components/SidebarV2.tsx`) is a
`MenuRadioGroup`: you get **all projects** or **exactly one**. There is no way to
watch a working set of three projects out of twenty, and no way to peek at one
project without destroying the scope you had.

## Solution

Turn the scope menu into a checkbox list with a per-row isolate control.

- **Left of each row:** a checkbox. Tick the projects you want in the sidebar.
- **Top row (`All projects`):** a tri-state checkbox — select all, deselect all,
  dash when the selection is partial.
- **Right of each row:** a `◎` isolate target, beside the existing `⋯` project
  actions button. Click it to view that project alone; click the filled `◉` to
  return to your checkboxes.

Isolate is a **temporary override**, never an edit to the selection. This is the
Photoshop solo model: peek at something outside your working set without
disturbing it.

## State model

Two independent pieces of state.

### Persisted: hidden project keys

New field in `packages/contracts/src/settings.ts`, following the existing
`sidebarProjectGroupingOverrides` pattern:

```ts
sidebarHiddenProjectKeys: Schema.Array(TrimmedNonEmptyString).pipe(
  Schema.withDecodingDefault(Effect.succeed([])),
);
```

Plus the matching `Schema.optionalKey(...)` entry in the settings-patch schema.

**Hidden keys, not selected keys.** A project added next week is visible by
default rather than silently missing from a stale selection. Checked means "not
in the hidden set". Keys for projects that no longer exist are ignored on read
and pruned on write.

Values are `SidebarProjectSnapshot.projectKey` — logical keys derived from the
active grouping mode. Changing grouping mode can therefore invalidate stored
keys; that degrades to "those projects become visible again", which is the safe
direction.

### Ephemeral: isolated project key

`isolatedProjectKey: string | null` stays component `useState`. It is never
persisted, so a reload always returns to the checkbox selection. It replaces
today's `projectScopeKey`.

Isolate may target a project that is currently unchecked — that is the point of
solo.

### Effective scope

```
effectiveKeys = isolatedProjectKey !== null
  ? [isolatedProjectKey]
  : allProjectKeys.filter(key => !hiddenKeys.has(key))
```

`effectiveKeys` feeds the existing `scopedProjectKeys` set (union of
`memberProjectRefs` mapped to `environmentId:projectId`). Everything downstream
of thread filtering is unchanged.

## Empty selection is a real state

Deselecting everything shows `No projects selected` with a `Select all` action,
and it persists across reload.

This is deliberate. Falling back to "show everything" when nothing is selected
would break the deselect-all-then-tick-two workflow, which is the main reason
the tri-state top row exists. An honest empty state beats a magic fallback.

## Trigger label

| State            | Label                                |
| ---------------- | ------------------------------------ |
| Nothing hidden   | `All projects`                       |
| Partial          | `3 of 8 projects`                    |
| Nothing selected | `No projects selected`               |
| Isolated         | project favicon + display name + `◉` |

`3 of 8 projects` always reveals that a filter is active and how much is hidden,
and its width does not swing with project name length — the constraint the
current design comment calls out. The `◉` on the collapsed trigger means isolate
can be exited without opening the menu.

## Code structure

`SidebarV2.tsx` is ~2730 lines. The logic does not go inline.

**New:** `apps/web/src/components/sidebarProjectScope.ts` — pure functions, no
React:

- `resolveProjectScope({ projectGroups, hiddenKeys, isolatedKey })` →
  `{ effectiveKeys, scopedProjectKeys, triggerLabel, allCheckboxState }`
- `toggleProjectHidden(hiddenKeys, key)` → next hidden keys
- `toggleAllHidden(hiddenKeys, allKeys)` → all-or-none
- `pruneHiddenKeys(hiddenKeys, allKeys)` → drops keys for projects that no
  longer exist

This matches the existing `Sidebar.logic.ts` and upstream's
`home-list-filter-menu.ts`, both pure modules with unit tests. The component
keeps wiring only.

**Menu:** `MenuRadioGroup` → checkbox menu items with `closeOnClick={false}`, so
several projects can be ticked in one pass. Isolate closes the menu — the choice
is made. The `⋯` project actions button stays exactly where it is.

## Existing behaviour that must follow the effective scope

Both currently key off `projectScopeKey` and break silently if the state type is
swapped without touching them:

1. **`clearSelection()` on scope change.** Bulk thread actions must never count
   or touch rows hidden by a filter change. Must fire on checkbox edits _and_
   isolate toggles.
2. **`settledResetKey` paging reset.** Becomes a stable string derived from the
   sorted effective key set, so a scope flip never inherits deep page state.

## Empty-state copy

Three variants replace today's single `No threads in ${displayName} yet`:

- Isolated → `No threads in {name} yet`
- Partial selection → `No threads in the {n} selected projects yet`
- Nothing selected → `No projects selected` + `Select all`

## Testing

Unit tests on `sidebarProjectScope.ts`:

- toggle one project on/off
- select all / deselect all from each of: all visible, partial, none visible
- tri-state checkbox resolution
- trigger label for every row of the table above
- stale keys pruned; a key for a deleted project never suppresses a live one
- a newly added project is visible by default against a non-empty hidden set
- isolate overrides the selection, including for an unchecked project
- **regression:** exiting isolate restores the exact prior selection — isolating
  must not mutate persisted hidden keys

Every test is verified by breaking the implementation and confirming a clear
failure before it is trusted.

## Scope boundaries

- Sidebar V2 only (`sidebarV2Enabled`, default false). The V1 sidebar
  (`Sidebar.tsx`) is untouched.
- Mobile (`ThreadNavigationSidebar.tsx`, `home-list-filter-menu.ts`) is
  untouched.
- No change to project grouping, sorting, or the `⋯` actions menu.

## Prerequisite

`SidebarV2.tsx` landed upstream after the previous worktree checkout. Work
branches from `origin/main` (`e7b99a8d1` or later).
