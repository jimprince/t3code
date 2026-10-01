import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  groupSidebarChildren,
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
    session: null,
    latestTurn: null,
    settledOverride: null,
    ...overrides,
  };
}
const key = (value: SidebarChild) => scopedThreadKey(scopeThreadRef(value.environmentId, value.id));

describe("sidebar nested children", () => {
  it("counts running and blocked children once, excluding settled, archived, and idle children", () => {
    const parent = thread("parent");
    const child = (id: string, overrides: Partial<SidebarChild> = {}) =>
      thread(id, { parentThreadId: parent.id, ...overrides });
    const children = [
      child("running", { session: { status: "running" }, hasPendingUserInput: true }),
      child("input", { hasPendingUserInput: true }),
      child("approval", { hasPendingApprovals: true }),
      child("settled", { settledOverride: "settled", hasPendingUserInput: true }),
      child("archived", { archivedAt: "2026-10-01T00:01:00Z", hasPendingUserInput: true }),
      child("idle"),
    ];
    const group = groupSidebarChildren([parent, ...children]).get(key(parent))!;
    expect(group.activeCount).toBe(3);
    expect(group.children.map((value) => value.id)).toEqual([
      "approval",
      "idle",
      "input",
      "running",
      "settled",
    ]);
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
