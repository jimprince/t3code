import { describe, expect, it } from "vite-plus/test";
import { applySidebarThreadNesting } from "../../threadNesting.logic";
import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  groupSidebarChildren,
  isActiveSidebarChild,
  resolveSidebarChildStatus,
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

  it("collapses siblings by default, expands all children, and preserves the open child when collapsing", () => {
    const children = [thread("one"), thread("two")];
    expect(visibleSidebarChildren(children, false, null)).toEqual([]);
    expect(visibleSidebarChildren(children, true, null)).toEqual(children);
    expect(visibleSidebarChildren(children, false, key(children[1]!))).toEqual([children[1]]);
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
    expect(visibleSidebarChildren(group.children, false, null)).toEqual([]);
    expect(visibleSidebarChildren(group.children, true, null)).toEqual([child]);
    expect(visibleSidebarChildren(group.children, false, key(child))).toEqual([child]);
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
