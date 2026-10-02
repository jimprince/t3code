import { describe, expect, it } from "vite-plus/test";
import { resolveSidebarThreadStatus } from "../Sidebar.logic";
import { applySidebarThreadNesting } from "../../threadNesting.logic";
import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  flattenVisibleSidebarChildren,
  flattenTidiedSidebarChildren,
  groupSidebarChildren,
  hasActiveSidebarDescendants,
  isActiveSidebarChild,
  resolveSidebarChildStatus,
  sidebarNestedPathKeys,
  sidebarPinnedPathKeys,
  visibleSidebarChildren,
  type SidebarChild,
} from "./nestedThreadVisibility.logic";

// Fixtures cover only the fields consumed by sidebar nesting and visibility.
function thread(id: string, overrides: Partial<SidebarChild> = {}): SidebarChild {
  return {
    id: ThreadId.make(id),
    environmentId: EnvironmentId.make("env-a"),
    projectId: ProjectId.make("project-a"),
    parentThreadId: null,
    archivedAt: null,
    createdAt: "2026-10-01T00:00:00Z",
    updatedAt: "2026-10-01T00:00:01Z",
    title: id,
    pinnedAt: null,
    pinOrderKey: null,
    activeOrderKey: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    backgroundLiveness: null,
    session: null,
    latestTurn: null,
    settledOverride: null,
    ...overrides,
  };
}
const key = (value: SidebarChild) => scopedThreadKey(scopeThreadRef(value.environmentId, value.id));

describe("sidebar nested children", () => {
  it("counts active children once and sorts them ahead of quiet children", () => {
    const parent = thread("parent");
    const child = (id: string, overrides: Partial<SidebarChild> = {}) =>
      thread(id, { parentThreadId: parent.id, ...overrides });
    const children = [
      child("running", { session: { status: "running" }, hasPendingUserInput: true }),
      child("input", { hasPendingUserInput: true }),
      child("approval", { hasPendingApprovals: true }),
      child("monitor", { backgroundLiveness: "monitoring" }),
      child("settled", { settledOverride: "settled", hasPendingUserInput: true }),
      child("archived", { archivedAt: "2026-10-01T00:01:00Z", hasPendingUserInput: true }),
      child("idle"),
    ];
    const group = groupSidebarChildren([parent, ...children]).get(key(parent))!;
    expect(group.activeCount).toBe(4);
    expect(group.children.map((value) => value.id)).toEqual([
      "approval",
      "input",
      "monitor",
      "running",
      "idle",
      "settled",
    ]);
  });

  it("uses a running turn as a working fallback without overriding authoritative session state", () => {
    const runningTurn = thread("turn", { latestTurn: { state: "running" } });
    expect(resolveSidebarChildStatus(runningTurn)).toBe("working");
    expect(isActiveSidebarChild(runningTurn)).toBe(true);
    expect(resolveSidebarChildStatus({ ...runningTurn, session: { status: "stopped" } })).toBe(
      "ready",
    );
    expect(isActiveSidebarChild({ ...runningTurn, session: { status: "stopped" } })).toBe(false);
  });

  it("keeps environments separate and leaves orphan children to the ordinary sidebar", () => {
    const parent = thread("parent");
    const foreign = thread("foreign", {
      environmentId: EnvironmentId.make("env-b"),
      parentThreadId: parent.id,
      hasPendingUserInput: true,
    });
    expect(groupSidebarChildren([parent, foreign]).size).toBe(0);
    expect(
      groupSidebarChildren(
        [parent, thread("child", { parentThreadId: parent.id, hasPendingUserInput: true })],
        new Set(),
      ).size,
    ).toBe(0);
    expect(
      groupSidebarChildren([
        thread("parent", { archivedAt: "2026-10-01T00:01:00Z" }),
        thread("child", { parentThreadId: parent.id }),
      ]).size,
    ).toBe(0);
  });

  it("counts active descendants and keeps their branch first at every depth", () => {
    const root = thread("root");
    const quiet = thread("quiet", { parentThreadId: root.id });
    const branch = thread("branch", { parentThreadId: root.id });
    const worker = thread("worker", {
      parentThreadId: branch.id,
      session: { status: "running" },
    });
    const waiting = thread("waiting", {
      parentThreadId: worker.id,
      hasPendingUserInput: true,
    });
    const groups = groupSidebarChildren([root, quiet, branch, worker, waiting]);
    expect(groups.get(key(root))?.activeCount).toBe(2);
    expect(groups.get(key(root))?.inputChildren.map((child) => child.id)).toEqual([waiting.id]);
    expect(groups.get(key(root))?.children.map((child) => child.id)).toEqual([branch.id, quiet.id]);
    expect(groups.get(key(branch))?.activeCount).toBe(2);
    expect(groups.get(key(branch))?.inputChildren.map((child) => child.id)).toEqual([waiting.id]);
    expect(groups.get(key(worker))?.activeCount).toBe(1);
    expect(hasActiveSidebarDescendants(groups, key(root))).toBe(true);
    expect(hasActiveSidebarDescendants(groups, key(quiet))).toBe(false);
  });

  it("sorts pinned siblings first and restores ordinary ordering after unpinning", () => {
    const root = thread("root");
    const active = thread("active", {
      parentThreadId: root.id,
      session: { status: "running" },
    });
    const pinned = thread("pinned", {
      parentThreadId: root.id,
      pinnedAt: "2026-10-01T01:00:00Z",
    });
    expect(groupSidebarChildren([root, active, pinned]).get(key(root))?.children).toEqual([
      pinned,
      active,
    ]);
    expect(
      groupSidebarChildren([root, active, { ...pinned, pinnedAt: null }])
        .get(key(root))
        ?.children.map((child) => child.id),
    ).toEqual([active.id, pinned.id]);
    expect(applySidebarThreadNesting([root, pinned])).toEqual([root]);
  });

  it("preserves drag order inside pinned and unpinned sibling buckets", () => {
    const root = thread("root");
    const pinnedLater = thread("pinned-later", {
      parentThreadId: root.id,
      pinnedAt: "2026-10-01T01:00:00Z",
      pinOrderKey: "z",
    });
    const pinnedFirst = thread("pinned-first", {
      parentThreadId: root.id,
      pinnedAt: "2026-10-01T02:00:00Z",
      pinOrderKey: "a",
    });
    const activeLater = thread("active-later", {
      parentThreadId: root.id,
      activeOrderKey: "z",
    });
    const activeFirst = thread("active-first", {
      parentThreadId: root.id,
      activeOrderKey: "a",
    });

    expect(
      groupSidebarChildren([root, pinnedLater, activeLater, pinnedFirst, activeFirst])
        .get(key(root))
        ?.children.map((child) => child.id),
    ).toEqual([pinnedFirst.id, pinnedLater.id, activeFirst.id, activeLater.id]);
  });

  it("collapses siblings by default, expands all children, and preserves the open descendant path", () => {
    const children = [thread("one"), thread("two")];
    expect(visibleSidebarChildren(children, false, new Set())).toEqual([]);
    expect(visibleSidebarChildren(children, true, new Set())).toEqual(children);

    const root = thread("root");
    const child = thread("child", { parentThreadId: root.id });
    const grandchild = thread("grandchild", { parentThreadId: child.id });
    const path = sidebarNestedPathKeys([root, child, grandchild], key(grandchild));
    expect(path).toEqual(new Set([key(grandchild), key(child)]));
    expect(visibleSidebarChildren([child], false, path)).toEqual([child]);
    expect(visibleSidebarChildren([grandchild], false, path)).toEqual([grandchild]);
  });

  it("flattens three visible nesting levels with compact row depths", () => {
    const root = thread("root");
    const child = thread("child", { parentThreadId: root.id });
    const grandchild = thread("grandchild", { parentThreadId: child.id });
    const greatGrandchild = thread("great-grandchild", { parentThreadId: grandchild.id });
    const groups = groupSidebarChildren([root, child, grandchild, greatGrandchild]);
    expect(
      flattenVisibleSidebarChildren({
        rootParentKey: key(root),
        groups,
        expandedParentKeys: new Set([key(root), key(child), key(grandchild)]),
        viewedPathKeys: new Set(),
      }).map(({ thread: row, depth }) => [row.id, depth]),
    ).toEqual([
      [child.id, 1],
      [grandchild.id, 2],
      [greatGrandchild.id, 3],
    ]);
  });

  it("keeps a pinned descendant and its ancestor path visible while collapsed", () => {
    const root = thread("root");
    const child = thread("child", { parentThreadId: root.id });
    const pinnedGrandchild = thread("pinned-grandchild", {
      parentThreadId: child.id,
      pinnedAt: "2026-10-01T01:00:00Z",
    });
    const hiddenSibling = thread("hidden", { parentThreadId: root.id });
    const groups = groupSidebarChildren([root, child, pinnedGrandchild, hiddenSibling]);
    const pinnedPath = sidebarPinnedPathKeys(groups);

    expect(pinnedPath).toEqual(new Set([key(pinnedGrandchild), key(child)]));
    expect(
      flattenVisibleSidebarChildren({
        rootParentKey: key(root),
        groups,
        expandedParentKeys: new Set(),
        viewedPathKeys: pinnedPath,
      }).map(({ thread: row, depth }) => [row.id, depth]),
    ).toEqual([
      [child.id, 1],
      [pinnedGrandchild.id, 2],
    ]);

    const unpinnedGroups = groupSidebarChildren([
      root,
      child,
      { ...pinnedGrandchild, pinnedAt: null },
      hiddenSibling,
    ]);
    expect(sidebarPinnedPathKeys(unpinnedGroups)).toEqual(new Set());
    expect(
      flattenVisibleSidebarChildren({
        rootParentKey: key(root),
        groups: unpinnedGroups,
        expandedParentKeys: new Set(),
        viewedPathKeys: sidebarPinnedPathKeys(unpinnedGroups),
      }),
    ).toEqual([]);
  });

  it("folds quiet children behind one done row while keeping supervised branches visible", () => {
    const root = thread("root");
    const working = thread("working", {
      parentThreadId: root.id,
      session: { status: "running" },
    });
    const pinned = thread("pinned", {
      parentThreadId: root.id,
      pinnedAt: "2026-10-01T00:00:00Z",
    });
    const branch = thread("branch", { parentThreadId: root.id });
    const waiting = thread("waiting", {
      parentThreadId: branch.id,
      hasPendingUserInput: true,
    });
    const doneOne = thread("done-one", {
      parentThreadId: root.id,
      settledOverride: "settled",
    });
    const doneTwo = thread("done-two", {
      parentThreadId: root.id,
      latestTurn: { state: "completed" },
    });
    const groups = groupSidebarChildren([root, working, pinned, branch, waiting, doneOne, doneTwo]);
    const collapsed = flattenTidiedSidebarChildren({
      rootParentKey: key(root),
      groups,
      expandedParentKeys: new Set([key(root)]),
      viewedPathKeys: new Set(),
      expandedDoneGroupKeys: new Set(),
      expandedBurstGroupKeys: new Set(),
    });

    expect(
      collapsed.map((row) => [row.kind, row.kind === "thread" ? row.thread.id : row.count]),
    ).toEqual([
      ["thread", pinned.id],
      ["thread", branch.id],
      ["thread", working.id],
      ["done", 2],
    ]);

    const doneKey = collapsed.find((row) => row.kind === "done")!.key;
    expect(
      flattenTidiedSidebarChildren({
        rootParentKey: key(root),
        groups,
        expandedParentKeys: new Set([key(root)]),
        viewedPathKeys: new Set(),
        expandedDoneGroupKeys: new Set([doneKey]),
        expandedBurstGroupKeys: new Set(),
      }).map((row) => (row.kind === "thread" ? row.thread.id : row.kind)),
    ).toEqual([pinned.id, branch.id, working.id, "done", doneOne.id, doneTwo.id]);
  });

  it("groups untouched creation bursts and removes a child as soon as it becomes active", () => {
    const root = thread("root");
    const halloweenOne = thread("halloween-one", {
      parentThreadId: root.id,
      title: "Halloween animal concepts",
      createdAt: "2026-10-01T00:00:00Z",
      updatedAt: "2026-10-01T00:00:00Z",
    });
    const halloweenTwo = thread("halloween-two", {
      parentThreadId: root.id,
      title: "Halloween wearable concepts",
      createdAt: "2026-10-01T00:01:30Z",
      updatedAt: "2026-10-01T00:01:30Z",
    });
    const nowWorking = thread("halloween-working", {
      parentThreadId: root.id,
      title: "Halloween lighting concepts",
      createdAt: "2026-10-01T00:01:45Z",
      updatedAt: "2026-10-01T00:01:45Z",
      session: { status: "running" },
    });
    const individuallyTouched = thread("touched", {
      parentThreadId: root.id,
      title: "Halloween touched concept",
      createdAt: "2026-10-01T00:01:50Z",
      updatedAt: "2026-10-01T00:02:00Z",
    });
    const groups = groupSidebarChildren([
      root,
      halloweenOne,
      halloweenTwo,
      nowWorking,
      individuallyTouched,
    ]);
    const rows = flattenTidiedSidebarChildren({
      rootParentKey: key(root),
      groups,
      expandedParentKeys: new Set([key(root)]),
      viewedPathKeys: new Set(),
      expandedDoneGroupKeys: new Set(),
      expandedBurstGroupKeys: new Set(),
    });

    expect(
      rows.map((row) => [row.kind, row.kind === "thread" ? row.thread.id : row.count]),
    ).toEqual([
      ["thread", nowWorking.id],
      ["burst", 2],
      ["done", 1],
    ]);
    const burst = rows.find((row) => row.kind === "burst")!;
    expect(burst.label).toBe("Halloween · 2");
    expect(
      flattenTidiedSidebarChildren({
        rootParentKey: key(root),
        groups,
        expandedParentKeys: new Set([key(root)]),
        viewedPathKeys: new Set(),
        expandedDoneGroupKeys: new Set(),
        expandedBurstGroupKeys: new Set([burst.key]),
      }).map((row) => (row.kind === "thread" ? row.thread.id : row.kind)),
    ).toEqual([nowWorking.id, "burst", halloweenOne.id, halloweenTwo.id, "done"]);
  });

  it("does not show folded or burst controls beneath a collapsed parent", () => {
    const root = thread("root");
    const pinned = thread("pinned", {
      parentThreadId: root.id,
      pinnedAt: "2026-10-01T00:00:00Z",
    });
    const quiet = thread("quiet", {
      parentThreadId: root.id,
      settledOverride: "settled",
    });
    const groups = groupSidebarChildren([root, pinned, quiet]);
    expect(
      flattenTidiedSidebarChildren({
        rootParentKey: key(root),
        groups,
        expandedParentKeys: new Set(),
        viewedPathKeys: sidebarPinnedPathKeys(groups),
        expandedDoneGroupKeys: new Set(),
        expandedBurstGroupKeys: new Set(),
      }).map((row) => (row.kind === "thread" ? row.thread.id : row.kind)),
    ).toEqual([pinned.id]);
  });
});

describe("cross-project sidebar integration", () => {
  const parent = thread("parent");
  const child = thread("cross-project", {
    parentThreadId: parent.id,
    projectId: ProjectId.make("project-b"),
    session: { status: "running" },
  });

  it("counts and expands a worker from its own project and keeps it reachable when collapsed", () => {
    const group = groupSidebarChildren([parent, child]).get(key(parent))!;
    expect(group.activeCount).toBe(1);
    expect(group.children).toEqual([child]);
    expect(group.children[0]!.projectId).toBe(child.projectId);
    expect(visibleSidebarChildren(group.children, false, new Set())).toEqual([]);
    expect(visibleSidebarChildren(group.children, true, new Set())).toEqual([child]);
    expect(visibleSidebarChildren(group.children, false, new Set([key(child)]))).toEqual([child]);
  });

  it("applies the child filter and returns orphaned workers to their own project", () => {
    const childProjectOnly = new Set([`${child.environmentId}:${child.projectId}`]);
    expect(groupSidebarChildren([parent, child], childProjectOnly).size).toBe(0);
    const orphan = { ...child, session: null };
    const eligible = [{ ...parent, session: null }, orphan].filter((entry) =>
      childProjectOnly.has(`${entry.environmentId}:${entry.projectId}`),
    );
    expect(applySidebarThreadNesting(eligible)).toEqual([orphan]);
    expect(applySidebarThreadNesting([orphan])).toEqual([orphan]);
    expect(groupSidebarChildren([child]).size).toBe(0);
    expect(
      groupSidebarChildren([{ ...parent, archivedAt: "2026-10-01T00:01:00Z" }, child]).size,
    ).toBe(0);
    expect(
      groupSidebarChildren(
        [parent, child],
        new Set([`${parent.environmentId}:${parent.projectId}`]),
      ).size,
    ).toBe(0);
  });
});

it("keeps a working parent's own state while identifying waiting children, and clears on lifecycle changes", () => {
  const parent = thread("parent", { session: { status: "running" } });
  const input = thread("input", { parentThreadId: parent.id, hasPendingUserInput: true });
  const list = applySidebarThreadNesting([parent, input]);
  expect(
    resolveSidebarThreadStatus({
      ...list[0]!,
      session: {
        threadId: parent.id,
        status: "running",
        providerName: null,
        runtimeMode: "full-access",
        activeTurnId: null,
        lastError: null,
        updatedAt: parent.createdAt,
      },
      backgroundLiveness: null,
    }),
  ).toBe("working");
  const group = groupSidebarChildren([parent, input]).get(key(parent))!;
  expect(group.inputChildren.map((child) => child.id)).toEqual([input.id]);
  for (const changed of [
    { ...input, settledOverride: "settled" as const },
    { ...input, archivedAt: "2026-10-01T01:00:00Z" },
    { ...input, hasPendingUserInput: false },
  ]) {
    expect(groupSidebarChildren([parent, changed]).get(key(parent))?.inputChildren ?? []).toEqual(
      [],
    );
  }
});
