# Sidebar V2 Multi-Project Scope Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Sidebar V2 all-or-one project scope menu with a persisted checkbox multi-select plus a temporary Photoshop-style isolate control.

**Architecture:** A new pure module `apps/web/src/components/sidebarProjectScope.ts` owns every scope decision (which projects are visible, the trigger label, the tri-state checkbox, the paging reset key). `SidebarV2.tsx` keeps only React wiring. Persistence rides on the existing client-settings schema as `sidebarHiddenProjectKeys`; isolate stays component state and is never persisted.

**Tech Stack:** React 19, TypeScript, effect/Schema (`packages/contracts`), Base UI menus (`@base-ui/react`), lucide-react icons, vite-plus test runner (`vp test run`).

**Spec:** `docs/superpowers/specs/2026-07-24-sidebar-v2-multi-project-scope-design.md`

## Global Constraints

- Branch from `origin/main` at `e7b99a8d1` or later. `SidebarV2.tsx` does not exist in older checkouts.
- Store **hidden** project keys, never selected keys. A newly added project must be visible by default.
- Isolate must never mutate `sidebarHiddenProjectKeys`. Exiting isolate restores the exact prior selection.
- Isolate is never persisted. A reload always returns to the checkbox selection.
- Zero projects selected is a real, persisted state that renders `No projects selected` + `Select all`. Do **not** fall back to showing everything.
- Trigger label copy, exactly: `All projects` / `3 of 8 projects` / `No projects selected` / the isolated project's `displayName`.
- Sidebar V2 only. Do not touch `apps/web/src/components/Sidebar.tsx` or any mobile file.
- Run focused tests only: `vp test run <file>`. Never run repo-wide `vp check` / `vp run test` (per `AGENTS.md`).
- Every regression test must be seen to fail before it is trusted.

---

### Task 1: Persist hidden project keys in client settings

**Files:**
- Modify: `packages/contracts/src/settings.ts` (schema ~line 101-116, patch schema ~line 602-610)
- Modify: `apps/desktop/src/settings/DesktopClientSettings.test.ts:15-34`

**Interfaces:**
- Consumes: nothing
- Produces: `ClientSettings["sidebarHiddenProjectKeys"]: readonly string[]`, defaulting to `[]`. Readable via `useClientSettings((s) => s.sidebarHiddenProjectKeys)` and writable via `updateSettings({ sidebarHiddenProjectKeys: [...] })`.

Dependencies are not installed in a fresh worktree. Install them first — every later task needs the test runner.

- [ ] **Step 1: Install dependencies**

```bash
pnpm install
```

Expected: completes without error, `node_modules/.bin/vp` exists.

- [ ] **Step 2: Add the field to `ClientSettingsSchema`**

In `packages/contracts/src/settings.ts`, insert directly **after** the `sidebarAutoSettleAfterDays` entry and **before** `sidebarProjectGroupingMode` (the block is alphabetized):

```ts
  sidebarHiddenProjectKeys: Schema.Array(TrimmedNonEmptyString).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
```

`TrimmedNonEmptyString` is already imported at the top of the file from `./baseSchemas.ts` — do not add an import.

- [ ] **Step 3: Add the field to `ClientSettingsPatch`**

In the same file, insert after the `sidebarAutoSettleAfterDays` patch entry:

```ts
  sidebarHiddenProjectKeys: Schema.optionalKey(Schema.Array(TrimmedNonEmptyString)),
```

- [ ] **Step 4: Fix the exhaustive desktop settings fixture**

`apps/desktop/src/settings/DesktopClientSettings.test.ts` declares a fully-typed `const clientSettings: ClientSettings = {...}`. Adding a required field breaks it. Insert after the `sidebarAutoSettleAfterDays: 3,` line:

```ts
  sidebarHiddenProjectKeys: ["environment-1:/tmp/project-b"],
```

- [ ] **Step 5: Run the desktop settings test**

Run: `node_modules/.bin/vp test run apps/desktop/src/settings/DesktopClientSettings.test.ts`
Expected: PASS. This proves the new field round-trips through encode/decode to disk.

- [ ] **Step 6: Typecheck the two changed packages**

Run: `node_modules/.bin/vp run typecheck --filter @t3tools/contracts --filter @t3tools/desktop`
Expected: no errors. If the `--filter` flags are unsupported by this repo's `vp`, run `node_modules/.bin/tsc --noEmit -p packages/contracts` instead. Do not run a repo-wide check.

- [ ] **Step 7: Commit**

```bash
git add packages/contracts/src/settings.ts apps/desktop/src/settings/DesktopClientSettings.test.ts
git commit -m "feat(contracts): persist sidebar hidden project keys"
```

---

### Task 2: Selection primitives

**Files:**
- Create: `apps/web/src/components/sidebarProjectScope.ts`
- Create: `apps/web/src/components/sidebarProjectScope.test.ts`

**Interfaces:**
- Consumes: `SidebarProjectSnapshot` from `../sidebarProjectGrouping.ts` (only `projectKey`, `displayName`, and `memberProjectRefs` are used).
- Produces:
  - `type AllProjectsCheckboxState = "all" | "none" | "partial"`
  - `pruneHiddenProjectKeys(hiddenProjectKeys: readonly string[], projectGroups: readonly SidebarProjectSnapshot[]): readonly string[]`
  - `toggleHiddenProjectKey(hiddenProjectKeys: readonly string[], projectKey: string): readonly string[]`
  - `toggleAllHiddenProjectKeys(hiddenProjectKeys: readonly string[], projectGroups: readonly SidebarProjectSnapshot[]): readonly string[]`
  - `resolveAllProjectsCheckboxState(hiddenProjectKeys: readonly string[], projectGroups: readonly SidebarProjectSnapshot[]): AllProjectsCheckboxState`

Every function is pure and returns new arrays. Hidden keys are stored sorted so settings writes are stable and don't churn on reorder.

- [ ] **Step 1: Write the failing test**

Create `apps/web/src/components/sidebarProjectScope.test.ts`:

```ts
import { describe, expect, it } from "vite-plus/test";

import type { SidebarProjectSnapshot } from "../sidebarProjectGrouping.ts";
import {
  pruneHiddenProjectKeys,
  resolveAllProjectsCheckboxState,
  toggleAllHiddenProjectKeys,
  toggleHiddenProjectKey,
} from "./sidebarProjectScope.ts";

// Only the three fields the scope logic reads are populated. The full
// snapshot carries ~15 more fields that are irrelevant here, so the cast
// keeps the fixtures readable.
function projectGroup(
  projectKey: string,
  memberRefs: ReadonlyArray<readonly [string, string]> = [["env-1", projectKey]],
): SidebarProjectSnapshot {
  return {
    projectKey,
    displayName: projectKey,
    memberProjectRefs: memberRefs.map(([environmentId, projectId]) => ({
      environmentId,
      projectId,
    })),
  } as unknown as SidebarProjectSnapshot;
}

const groups = [projectGroup("alpha"), projectGroup("beta"), projectGroup("gamma")];

describe("toggleHiddenProjectKey", () => {
  it("hides a visible project", () => {
    expect(toggleHiddenProjectKey([], "beta")).toEqual(["beta"]);
  });

  it("shows a hidden project", () => {
    expect(toggleHiddenProjectKey(["beta", "gamma"], "beta")).toEqual(["gamma"]);
  });

  it("keeps the stored order sorted", () => {
    expect(toggleHiddenProjectKey(["gamma"], "alpha")).toEqual(["alpha", "gamma"]);
  });
});

describe("toggleAllHiddenProjectKeys", () => {
  it("hides every project when all are visible", () => {
    expect(toggleAllHiddenProjectKeys([], groups)).toEqual(["alpha", "beta", "gamma"]);
  });

  it("hides every project when the selection is partial", () => {
    expect(toggleAllHiddenProjectKeys(["beta"], groups)).toEqual(["alpha", "beta", "gamma"]);
  });

  it("shows every project when none are visible", () => {
    expect(toggleAllHiddenProjectKeys(["alpha", "beta", "gamma"], groups)).toEqual([]);
  });
});

describe("resolveAllProjectsCheckboxState", () => {
  it("is all when nothing is hidden", () => {
    expect(resolveAllProjectsCheckboxState([], groups)).toBe("all");
  });

  it("is partial when some are hidden", () => {
    expect(resolveAllProjectsCheckboxState(["beta"], groups)).toBe("partial");
  });

  it("is none when every project is hidden", () => {
    expect(resolveAllProjectsCheckboxState(["alpha", "beta", "gamma"], groups)).toBe("none");
  });

  it("is all for an empty project list", () => {
    expect(resolveAllProjectsCheckboxState([], [])).toBe("all");
  });
});

describe("pruneHiddenProjectKeys", () => {
  it("drops keys for projects that no longer exist", () => {
    expect(pruneHiddenProjectKeys(["beta", "deleted-project"], groups)).toEqual(["beta"]);
  });

  it("returns the same reference when nothing is stale", () => {
    const hidden = ["beta"];
    expect(pruneHiddenProjectKeys(hidden, groups)).toBe(hidden);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node_modules/.bin/vp test run apps/web/src/components/sidebarProjectScope.test.ts`
Expected: FAIL — cannot resolve `./sidebarProjectScope.ts`.

- [ ] **Step 3: Write the implementation**

Create `apps/web/src/components/sidebarProjectScope.ts`:

```ts
import type { SidebarProjectSnapshot } from "../sidebarProjectGrouping.ts";

export type AllProjectsCheckboxState = "all" | "none" | "partial";

// Hidden keys are stored sorted: settings writes are compared by value
// upstream, and an unsorted array would rewrite the settings file every
// time the project list reorders.
function sortKeys(keys: Iterable<string>): readonly string[] {
  return [...keys].toSorted();
}

export function toggleHiddenProjectKey(
  hiddenProjectKeys: readonly string[],
  projectKey: string,
): readonly string[] {
  const next = new Set(hiddenProjectKeys);
  if (next.has(projectKey)) {
    next.delete(projectKey);
  } else {
    next.add(projectKey);
  }
  return sortKeys(next);
}

export function toggleAllHiddenProjectKeys(
  hiddenProjectKeys: readonly string[],
  projectGroups: readonly SidebarProjectSnapshot[],
): readonly string[] {
  // Partial counts as "something is visible", so the first click always
  // clears the list rather than needing two clicks from a partial state.
  const hidden = new Set(hiddenProjectKeys);
  const allHidden =
    projectGroups.length > 0 && projectGroups.every((project) => hidden.has(project.projectKey));
  return allHidden ? [] : sortKeys(projectGroups.map((project) => project.projectKey));
}

export function resolveAllProjectsCheckboxState(
  hiddenProjectKeys: readonly string[],
  projectGroups: readonly SidebarProjectSnapshot[],
): AllProjectsCheckboxState {
  if (projectGroups.length === 0) return "all";
  const hidden = new Set(hiddenProjectKeys);
  const hiddenCount = projectGroups.filter((project) => hidden.has(project.projectKey)).length;
  if (hiddenCount === 0) return "all";
  if (hiddenCount === projectGroups.length) return "none";
  return "partial";
}

export function pruneHiddenProjectKeys(
  hiddenProjectKeys: readonly string[],
  projectGroups: readonly SidebarProjectSnapshot[],
): readonly string[] {
  const live = new Set(projectGroups.map((project) => project.projectKey));
  const pruned = hiddenProjectKeys.filter((key) => live.has(key));
  // Identity-stable when nothing was stale: callers use this in effects
  // and a fresh array every render would loop.
  return pruned.length === hiddenProjectKeys.length ? hiddenProjectKeys : pruned;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node_modules/.bin/vp test run apps/web/src/components/sidebarProjectScope.test.ts`
Expected: PASS, 12 tests.

- [ ] **Step 5: Verify the tests actually catch regressions**

Temporarily change `resolveAllProjectsCheckboxState` to `return "all";` unconditionally. Re-run the test.
Expected: FAIL on the partial and none cases. Revert the change and re-run to confirm PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/sidebarProjectScope.ts apps/web/src/components/sidebarProjectScope.test.ts
git commit -m "feat(web): add sidebar project selection primitives"
```

---

### Task 3: Scope resolution with isolate

**Files:**
- Modify: `apps/web/src/components/sidebarProjectScope.ts`
- Modify: `apps/web/src/components/sidebarProjectScope.test.ts`

**Interfaces:**
- Consumes: everything from Task 2.
- Produces:

```ts
interface ProjectScopeResolution {
  readonly effectiveProjectKeys: ReadonlySet<string>;
  readonly scopedProjectRefKeys: ReadonlySet<string> | null;
  readonly allCheckboxState: AllProjectsCheckboxState;
  readonly isolatedProject: SidebarProjectSnapshot | null;
  readonly triggerLabel: string;
  readonly settledResetKey: string;
}

function resolveProjectScope(input: {
  readonly projectGroups: readonly SidebarProjectSnapshot[];
  readonly hiddenProjectKeys: readonly string[];
  readonly isolatedProjectKey: string | null;
}): ProjectScopeResolution;
```

`scopedProjectRefKeys` is `null` when everything is visible and nothing is isolated. That preserves the existing "no filtering needed" fast path at `SidebarV2.tsx:1373`, where `null` short-circuits the per-thread check.

- [ ] **Step 1: Write the failing test**

Append to `apps/web/src/components/sidebarProjectScope.test.ts` (and add `resolveProjectScope` to the existing import from `./sidebarProjectScope.ts`):

```ts
describe("resolveProjectScope", () => {
  it("does not filter when everything is visible", () => {
    const scope = resolveProjectScope({
      projectGroups: groups,
      hiddenProjectKeys: [],
      isolatedProjectKey: null,
    });
    expect(scope.scopedProjectRefKeys).toBeNull();
    expect(scope.triggerLabel).toBe("All projects");
    expect(scope.allCheckboxState).toBe("all");
    expect(scope.isolatedProject).toBeNull();
  });

  it("labels and filters a partial selection", () => {
    const scope = resolveProjectScope({
      projectGroups: groups,
      hiddenProjectKeys: ["gamma"],
      isolatedProjectKey: null,
    });
    expect(scope.triggerLabel).toBe("2 of 3 projects");
    expect(scope.scopedProjectRefKeys).toEqual(new Set(["env-1:alpha", "env-1:beta"]));
  });

  it("shows nothing when every project is deselected", () => {
    const scope = resolveProjectScope({
      projectGroups: groups,
      hiddenProjectKeys: ["alpha", "beta", "gamma"],
      isolatedProjectKey: null,
    });
    expect(scope.triggerLabel).toBe("No projects selected");
    expect(scope.scopedProjectRefKeys).toEqual(new Set());
  });

  it("expands every member ref of a grouped project", () => {
    const grouped = [
      projectGroup("alpha", [
        ["env-1", "alpha"],
        ["env-2", "alpha-remote"],
      ]),
      projectGroup("beta"),
    ];
    const scope = resolveProjectScope({
      projectGroups: grouped,
      hiddenProjectKeys: ["beta"],
      isolatedProjectKey: null,
    });
    expect(scope.scopedProjectRefKeys).toEqual(new Set(["env-1:alpha", "env-2:alpha-remote"]));
  });

  it("isolate overrides the selection", () => {
    const scope = resolveProjectScope({
      projectGroups: groups,
      hiddenProjectKeys: ["gamma"],
      isolatedProjectKey: "alpha",
    });
    expect(scope.scopedProjectRefKeys).toEqual(new Set(["env-1:alpha"]));
    expect(scope.triggerLabel).toBe("alpha");
    expect(scope.isolatedProject?.projectKey).toBe("alpha");
  });

  it("isolates a project that is currently deselected", () => {
    const scope = resolveProjectScope({
      projectGroups: groups,
      hiddenProjectKeys: ["gamma"],
      isolatedProjectKey: "gamma",
    });
    expect(scope.scopedProjectRefKeys).toEqual(new Set(["env-1:gamma"]));
    expect(scope.triggerLabel).toBe("gamma");
  });

  it("ignores an isolate key whose project vanished", () => {
    const scope = resolveProjectScope({
      projectGroups: groups,
      hiddenProjectKeys: [],
      isolatedProjectKey: "deleted-project",
    });
    expect(scope.isolatedProject).toBeNull();
    expect(scope.scopedProjectRefKeys).toBeNull();
    expect(scope.triggerLabel).toBe("All projects");
  });

  it("REGRESSION: isolating never changes the checkbox state", () => {
    const hidden = ["gamma"];
    const isolated = resolveProjectScope({
      projectGroups: groups,
      hiddenProjectKeys: hidden,
      isolatedProjectKey: "alpha",
    });
    // The checkbox row for gamma must still read "unchecked" while
    // isolated, and dropping isolate must restore the exact prior scope.
    expect(isolated.allCheckboxState).toBe("partial");
    expect(hidden).toEqual(["gamma"]);
    const restored = resolveProjectScope({
      projectGroups: groups,
      hiddenProjectKeys: hidden,
      isolatedProjectKey: null,
    });
    expect(restored.scopedProjectRefKeys).toEqual(new Set(["env-1:alpha", "env-1:beta"]));
  });

  it("changes settledResetKey whenever the effective scope changes", () => {
    const base = resolveProjectScope({
      projectGroups: groups,
      hiddenProjectKeys: [],
      isolatedProjectKey: null,
    }).settledResetKey;
    const filtered = resolveProjectScope({
      projectGroups: groups,
      hiddenProjectKeys: ["gamma"],
      isolatedProjectKey: null,
    }).settledResetKey;
    const isolated = resolveProjectScope({
      projectGroups: groups,
      hiddenProjectKeys: ["gamma"],
      isolatedProjectKey: "alpha",
    }).settledResetKey;
    expect(new Set([base, filtered, isolated]).size).toBe(3);
  });

  it("keeps settledResetKey stable for an unchanged scope", () => {
    const input = {
      projectGroups: groups,
      hiddenProjectKeys: ["gamma"],
      isolatedProjectKey: null,
    } as const;
    expect(resolveProjectScope(input).settledResetKey).toBe(
      resolveProjectScope(input).settledResetKey,
    );
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node_modules/.bin/vp test run apps/web/src/components/sidebarProjectScope.test.ts`
Expected: FAIL — `resolveProjectScope` is not exported.

- [ ] **Step 3: Write the implementation**

Append to `apps/web/src/components/sidebarProjectScope.ts`:

```ts
export interface ProjectScopeResolution {
  readonly effectiveProjectKeys: ReadonlySet<string>;
  /** `null` means "no filtering needed" — every project is visible. */
  readonly scopedProjectRefKeys: ReadonlySet<string> | null;
  readonly allCheckboxState: AllProjectsCheckboxState;
  readonly isolatedProject: SidebarProjectSnapshot | null;
  readonly triggerLabel: string;
  readonly settledResetKey: string;
}

function collectProjectRefKeys(
  projectGroups: readonly SidebarProjectSnapshot[],
): ReadonlySet<string> {
  const refKeys = new Set<string>();
  for (const project of projectGroups) {
    for (const projectRef of project.memberProjectRefs) {
      refKeys.add(`${projectRef.environmentId}:${projectRef.projectId}`);
    }
  }
  return refKeys;
}

export function resolveProjectScope(input: {
  readonly projectGroups: readonly SidebarProjectSnapshot[];
  readonly hiddenProjectKeys: readonly string[];
  readonly isolatedProjectKey: string | null;
}): ProjectScopeResolution {
  const allCheckboxState = resolveAllProjectsCheckboxState(
    input.hiddenProjectKeys,
    input.projectGroups,
  );
  const isolatedProject =
    input.isolatedProjectKey === null
      ? null
      : (input.projectGroups.find(
          (project) => project.projectKey === input.isolatedProjectKey,
        ) ?? null);

  if (isolatedProject !== null) {
    return {
      effectiveProjectKeys: new Set([isolatedProject.projectKey]),
      scopedProjectRefKeys: collectProjectRefKeys([isolatedProject]),
      allCheckboxState,
      isolatedProject,
      triggerLabel: isolatedProject.displayName,
      settledResetKey: `isolated:${isolatedProject.projectKey}`,
    };
  }

  const hidden = new Set(input.hiddenProjectKeys);
  const visibleProjects = input.projectGroups.filter(
    (project) => !hidden.has(project.projectKey),
  );
  const effectiveProjectKeys = new Set(visibleProjects.map((project) => project.projectKey));

  const triggerLabel =
    allCheckboxState === "all"
      ? "All projects"
      : allCheckboxState === "none"
        ? "No projects selected"
        : `${visibleProjects.length} of ${input.projectGroups.length} projects`;

  return {
    effectiveProjectKeys,
    // Everything visible short-circuits the per-thread filter downstream.
    scopedProjectRefKeys:
      allCheckboxState === "all" ? null : collectProjectRefKeys(visibleProjects),
    allCheckboxState,
    isolatedProject: null,
    triggerLabel,
    settledResetKey:
      allCheckboxState === "all"
        ? "all"
        : `selected:${[...effectiveProjectKeys].toSorted().join(" ")}`,
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node_modules/.bin/vp test run apps/web/src/components/sidebarProjectScope.test.ts`
Expected: PASS, 22 tests.

- [ ] **Step 5: Verify the regression test catches the bug it names**

Temporarily make the isolate branch also write the selection, e.g. change the isolate branch's `allCheckboxState` to `"all"`. Re-run.
Expected: the `REGRESSION: isolating never changes the checkbox state` test FAILS. Revert and re-run to confirm PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/sidebarProjectScope.ts apps/web/src/components/sidebarProjectScope.test.ts
git commit -m "feat(web): resolve sidebar project scope with isolate override"
```

---

### Task 4: Wire the scope menu into SidebarV2

**Files:**
- Modify: `apps/web/src/components/SidebarV2.tsx` (imports ~line 78-88; state ~line 1174-1203; paging key ~line 1448; menu JSX ~line 2270-2345)

**Interfaces:**
- Consumes: `resolveProjectScope`, `toggleHiddenProjectKey`, `toggleAllHiddenProjectKeys`, `pruneHiddenProjectKeys` from Task 3; `sidebarHiddenProjectKeys` from Task 1.
- Produces: no exports. Behaviour only.

`projectScopeKey` / `setProjectScopeKey` / `scopedProjectGroup` are deleted. `scopedProjectKeys` keeps its name and its `ReadonlySet<string> | null` type so the consumer at line 1373 is untouched.

- [ ] **Step 1: Add imports**

Add to the icon import from `lucide-react` (alphabetical within the existing list): `CircleDotIcon`, `TargetIcon`. Add `MenuCheckboxItem` and `MenuSeparator` to the existing `./ui/menu.ts(x)` import if not already present, and remove `MenuRadioGroup` / `MenuRadioItem` if this file has no other use of them (check with `grep -n "MenuRadio" apps/web/src/components/SidebarV2.tsx`).

Add the scope module import beside the other local component imports:

```ts
import {
  pruneHiddenProjectKeys,
  resolveProjectScope,
  toggleAllHiddenProjectKeys,
  toggleHiddenProjectKey,
} from "./sidebarProjectScope.ts";
```

- [ ] **Step 2: Replace the scope state block**

Replace `SidebarV2.tsx` lines 1174-1203 (the comment block through the `clearSelection` effect) with:

```ts
  // Project scope: one menu above the list. Checkbox multi-select persists;
  // isolate is a temporary override that never touches the stored selection.
  const hiddenProjectKeys = useClientSettings((s) => s.sidebarHiddenProjectKeys);
  const [isolatedProjectKey, setIsolatedProjectKey] = useState<string | null>(null);
  const projectScope = useMemo(
    () => resolveProjectScope({ projectGroups, hiddenProjectKeys, isolatedProjectKey }),
    [hiddenProjectKeys, isolatedProjectKey, projectGroups],
  );
  const scopedProjectKeys = projectScope.scopedProjectRefKeys;

  const setHiddenProjectKeys = useCallback(
    (nextHiddenProjectKeys: readonly string[]) => {
      updateSettings({ sidebarHiddenProjectKeys: [...nextHiddenProjectKeys] });
    },
    [updateSettings],
  );

  // A project can disappear (removed, or regrouped under a different
  // grouping mode). Drop its key rather than letting a dead key suppress
  // a live project if the key is ever reused.
  useEffect(() => {
    const pruned = pruneHiddenProjectKeys(hiddenProjectKeys, projectGroups);
    if (pruned !== hiddenProjectKeys) setHiddenProjectKeys(pruned);
  }, [hiddenProjectKeys, projectGroups, setHiddenProjectKeys]);

  useEffect(() => {
    if (isolatedProjectKey !== null && projectScope.isolatedProject === null) {
      setIsolatedProjectKey(null);
    }
  }, [isolatedProjectKey, projectScope.isolatedProject]);

  // Scope flips drop the selection: rows selected under the old scope may be
  // hidden now, and bulk actions must never count or touch invisible rows.
  useEffect(() => {
    clearSelection();
  }, [clearSelection, projectScope.settledResetKey]);
```

`updateSettings` is already defined above at line 1020; do not redeclare it. Confirm `useCallback` is in the React import.

- [ ] **Step 3: Repoint the settled paging reset key**

Replace line 1448:

```ts
  const settledResetKey = projectScopeKey ?? "all";
```

with:

```ts
  const settledResetKey = projectScope.settledResetKey;
```

- [ ] **Step 4: Replace the menu trigger contents**

Inside the `MenuTrigger` (~line 2274-2288), replace the favicon/label/chevron children with:

```tsx
                  {projectScope.isolatedProject ? (
                    <ProjectFavicon
                      environmentId={projectScope.isolatedProject.environmentId}
                      cwd={projectScope.isolatedProject.workspaceRoot}
                      className="size-4 shrink-0"
                    />
                  ) : (
                    <FolderIcon className="size-4 shrink-0 text-sidebar-muted-foreground/80" />
                  )}
                  <span className="min-w-0 flex-1 truncate">{projectScope.triggerLabel}</span>
                  {projectScope.isolatedProject ? (
                    <span
                      role="button"
                      tabIndex={0}
                      aria-label="Stop isolating project"
                      className="inline-flex size-5 shrink-0 cursor-pointer items-center justify-center rounded text-primary"
                      onPointerDown={(event) => event.stopPropagation()}
                      onClick={(event) => {
                        event.stopPropagation();
                        setIsolatedProjectKey(null);
                      }}
                      onKeyDown={(event) => {
                        if (event.key !== "Enter" && event.key !== " ") return;
                        event.stopPropagation();
                        event.preventDefault();
                        setIsolatedProjectKey(null);
                      }}
                    >
                      <CircleDotIcon className="size-3.5" />
                    </span>
                  ) : null}
                  <ChevronDownIcon className="size-4 shrink-0 text-sidebar-muted-foreground/70" />
```

A nested `<button>` inside the trigger button would be invalid HTML, which is why this is a `role="button"` span with an explicit keyboard handler.

- [ ] **Step 5: Replace the radio group with checkbox rows**

Replace the whole `<MenuRadioGroup>…</MenuRadioGroup>` block (~line 2290-2340) with:

```tsx
                  <MenuItem
                    closeOnClick={false}
                    role="menuitemcheckbox"
                    aria-checked={
                      projectScope.allCheckboxState === "all"
                        ? true
                        : projectScope.allCheckboxState === "none"
                          ? false
                          : "mixed"
                    }
                    className="grid h-8 min-h-8 grid-cols-[1rem_1fr] items-center gap-2 px-1 py-0 text-sm font-medium"
                    onClick={() => {
                      setHiddenProjectKeys(
                        toggleAllHiddenProjectKeys(hiddenProjectKeys, projectGroups),
                      );
                    }}
                  >
                    <span className="col-start-1 flex size-4 items-center justify-center">
                      {projectScope.allCheckboxState === "all" ? (
                        <CheckIcon className="size-3.5" />
                      ) : projectScope.allCheckboxState === "partial" ? (
                        <MinusIcon className="size-3.5" />
                      ) : null}
                    </span>
                    <span className="col-start-2 flex min-w-0 items-center gap-2">
                      <FolderIcon className="size-4 shrink-0" />
                      <span className="min-w-0 truncate text-sm">All projects</span>
                    </span>
                  </MenuItem>
                  <MenuSeparator />
                  {projectGroups.map((project) => {
                    const isIsolated =
                      projectScope.isolatedProject?.projectKey === project.projectKey;
                    return (
                      <MenuCheckboxItem
                        key={project.projectKey}
                        checked={!hiddenProjectKeys.includes(project.projectKey)}
                        closeOnClick={false}
                        onCheckedChange={() => {
                          setHiddenProjectKeys(
                            toggleHiddenProjectKey(hiddenProjectKeys, project.projectKey),
                          );
                        }}
                        className="h-8 min-h-8 px-1 py-0 text-sm font-medium [&>span:last-child]:flex [&>span:last-child]:min-w-0 [&>span:last-child]:items-center [&>span:last-child]:gap-2"
                      >
                        <ProjectFavicon
                          environmentId={project.environmentId}
                          cwd={project.workspaceRoot}
                          className="size-4 shrink-0"
                        />
                        <span className="min-w-0 flex-1 truncate text-sm">
                          {project.displayName}
                        </span>
                        <button
                          type="button"
                          aria-label={
                            isIsolated
                              ? `Stop isolating ${project.displayName}`
                              : `Isolate ${project.displayName}`
                          }
                          title={isIsolated ? "Stop isolating" : "Isolate this project"}
                          className={`ml-auto inline-flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-md outline-none transition-colors hover:bg-accent focus-visible:bg-accent focus-visible:ring-2 focus-visible:ring-ring ${
                            isIsolated
                              ? "text-primary"
                              : "text-muted-foreground/55 hover:text-foreground"
                          }`}
                          onPointerDown={(event) => event.stopPropagation()}
                          onClick={(event) => {
                            event.stopPropagation();
                            // Isolate is a decision, so it closes the menu;
                            // ticking checkboxes does not.
                            setIsolatedProjectKey(isIsolated ? null : project.projectKey);
                            setProjectScopeMenuOpen(false);
                          }}
                        >
                          {isIsolated ? (
                            <CircleDotIcon className="size-3.5" />
                          ) : (
                            <TargetIcon className="size-3.5" />
                          )}
                        </button>
                        <button
                          type="button"
                          aria-label={`Project actions for ${project.displayName}`}
                          title={`Project actions for ${project.displayName}`}
                          className="inline-flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground/55 outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:bg-accent focus-visible:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                          onPointerDown={(event) => event.stopPropagation()}
                          onClick={(event) => {
                            void handleProjectActions(event, project);
                          }}
                        >
                          <EllipsisIcon className="size-3.5" />
                        </button>
                      </MenuCheckboxItem>
                    );
                  })}
```

`CheckIcon` and `MinusIcon` come from `lucide-react`; add them to the icon import. `MenuItem` must be imported from `./ui/menu` if it isn't already.

- [ ] **Step 6: Update the empty state**

Replace the `scopedProjectGroup ? … : "No threads yet"` branch (~line 2548-2551) with:

```tsx
              ) : projectScope.isolatedProject ? (
                `No threads in ${projectScope.isolatedProject.displayName} yet`
              ) : projectScope.allCheckboxState === "none" ? (
                <>
                  <span>No projects selected</span>
                  <button
                    type="button"
                    onClick={() => {
                      setHiddenProjectKeys([]);
                    }}
                    className="inline-flex items-center gap-1.5 rounded-md border border-sidebar-border px-2.5 py-1 text-[11px] font-medium text-sidebar-muted-foreground transition-colors hover:bg-sidebar-row-hover hover:text-sidebar-foreground"
                  >
                    Select all
                  </button>
                </>
              ) : projectScope.allCheckboxState === "partial" ? (
                `No threads in the ${projectScope.effectiveProjectKeys.size} selected projects yet`
              ) : (
                "No threads yet"
              )}
```

- [ ] **Step 7: Typecheck the web app**

Run: `node_modules/.bin/vp run typecheck --filter @t3tools/web`
Expected: no errors. Fix any leftover references to the deleted `projectScopeKey` / `scopedProjectGroup` (`grep -n "projectScopeKey\|scopedProjectGroup" apps/web/src/components/SidebarV2.tsx` must return nothing).

If `TargetIcon` or `CircleDotIcon` does not exist in the installed `lucide-react`, substitute `CrosshairIcon` and `FocusIcon` and note the swap in the commit message. Do not invent an icon name.

- [ ] **Step 8: Run the existing sidebar tests for regressions**

Run: `node_modules/.bin/vp test run apps/web/src/components/Sidebar.logic.test.ts apps/web/src/components/sidebarProjectScope.test.ts`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add apps/web/src/components/SidebarV2.tsx
git commit -m "feat(web): multi-select project scope with isolate in sidebar v2"
```

---

### Task 5: Integrated browser verification

**Files:**
- No source changes expected. Fix-forward commits only if a defect is found.

**Interfaces:**
- Consumes: the complete feature from Tasks 1-4.
- Produces: evidence that the flow works in a real browser.

`AGENTS.md` requires one integrated verification pass in a real client after any user-visible frontend change. Use the `test-t3-app` skill: launch one isolated environment, authenticate through the printed pairing URL, and drive the browser. Sidebar V2 is behind `sidebarV2Enabled` (default `false`) — turn it on in Settings first, and seed at least three projects.

- [ ] **Step 1: Launch an isolated environment and enable Sidebar V2**

Follow the `test-t3-app` skill. Seed ≥3 projects with ≥1 thread each. Enable Sidebar V2 in Settings.

- [ ] **Step 2: Verify multi-select**

Open the scope menu, untick one project. Expected: its threads leave the list, the menu stays open, the trigger reads `2 of 3 projects`.

- [ ] **Step 3: Verify deselect-all and the empty state**

Click `All projects`. Expected: everything unticks, the list shows `No projects selected` with a `Select all` button. Click `Select all`. Expected: all threads return and the trigger reads `All projects`.

- [ ] **Step 4: Verify isolate and restore**

Untick one project, then click the `◎` on a *different* project. Expected: the menu closes, only that project's threads show, the trigger shows its name plus a filled `◉`. Click the `◉` in the trigger. Expected: the previous 2-of-3 selection returns exactly.

- [ ] **Step 5: Verify isolating a deselected project**

Untick a project, reopen the menu, click `◎` on that same unticked project. Expected: its threads show. Exit isolate. Expected: it is unticked again and hidden.

- [ ] **Step 6: Verify persistence**

With a partial selection active and no isolate, reload the page. Expected: the selection is restored. Then isolate a project and reload. Expected: isolate is gone and the checkbox selection is intact.

- [ ] **Step 7: Stop the dev server**

Per `AGENTS.md`, shut down the dev server and any watchers when verification completes.

- [ ] **Step 8: Commit any fixes**

If steps 2-6 surfaced defects, fix them, add a focused regression test to `sidebarProjectScope.test.ts` where the defect is logic (verify it fails first), and commit.

---

## Notes for the implementer

- **Do not** persist `isolatedProjectKey`. If you find yourself writing it to settings, re-read the spec.
- **Do not** add a "fall back to all projects when nothing is selected" branch. Zero selected is intentional.
- The `⋯` project actions button and `handleProjectActions` are pre-existing. Leave their behaviour alone.
- `projectKey` values are logical keys derived from the active grouping mode. Switching grouping mode can invalidate stored keys; the prune effect in Task 4 Step 2 handles that by making the affected projects visible again.
