import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { supervisionForest } from "@t3tools/client-runtime/state/fork-nesting";
import { describe, expect, it } from "vite-plus/test";
import { makeThreadFixture } from "../test-fixtures";
import {
  nestUnderMenuTarget,
  resolveThreadNestingMenuState,
  withThreadNestingMenuItems,
} from "./threadNestingMenu.logic";

const environmentId = EnvironmentId.make("env");
const thread = (id: string, updatedAt: string) =>
  makeThreadFixture({ environmentId, id: ThreadId.make(id), updatedAt });
const threads = [
  thread("root", "2026-01-01T00:00:00Z"),
  thread("child", "2026-01-02T00:00:00Z"),
  thread("grand", "2026-01-03T00:00:00Z"),
  thread("other", "2026-01-04T00:00:00Z"),
];
const metadata = [
  { threadId: "child", parentThreadId: "root" },
  { threadId: "grand", parentThreadId: "child" },
].map((row) => ({ ...row, environmentId, remoteParent: null }) as never);
const forest = supervisionForest(threads, metadata);
const stateFor = (id: string) =>
  resolveThreadNestingMenuState({
    thread: threads.find((t) => t.id === id)!,
    forest,
    supported: true,
  });

describe("resolveThreadNestingMenuState", () => {
  it("offers no item when the host cannot nest", () => {
    expect(
      resolveThreadNestingMenuState({ thread: threads[0]!, forest, supported: false }),
    ).toBeNull();
  });

  it("excludes the thread, its current parent and its descendants, newest first", () => {
    const state = stateFor("child")!;
    expect(state.isNested).toBe(true);
    expect(state.parentCandidates.map((c) => c.id)).toEqual(["other"]);
    expect(stateFor("other")!.parentCandidates.map((c) => c.id)).toEqual([
      "grand",
      "child",
      "root",
    ]);
  });

  it("reports a top-level thread as not nested", () => {
    expect(stateFor("other")!.isNested).toBe(false);
  });
});

describe("withThreadNestingMenuItems", () => {
  const base = [
    { id: "new-thread-on-branch", label: "New thread on main" },
    { id: "pin", label: "Pin thread" },
    { id: "rename", label: "Rename" },
  ];

  it("places the new-thread item after the branch item and placement before rename", () => {
    const items = withThreadNestingMenuItems(base, stateFor("child"));
    expect(items.map((item) => item.id)).toEqual([
      "new-thread-on-branch",
      "new-nested-thread",
      "pin",
      "nest-under",
      "move-to-sidebar",
      "rename",
    ]);
  });

  it("omits Move to sidebar for a top-level thread and returns the menu unchanged when unsupported", () => {
    expect(
      withThreadNestingMenuItems(base, stateFor("other")).map((item) => item.id),
    ).not.toContain("move-to-sidebar");
    expect(withThreadNestingMenuItems(base, null)).toBe(base);
  });

  it("resolves the chosen parent from the state the menu was built with", () => {
    const state = stateFor("other");
    expect(nestUnderMenuTarget("nest-under:child", state)).toBe("child");
    expect(nestUnderMenuTarget("nest-under:nope", state)).toBeNull();
  });
});

describe("subproject menu items", () => {
  const modeThreads = threads.map((t) =>
    t.id === "child" ? { ...t, subproject: "on" as const } : t,
  );
  const modeForest = supervisionForest(modeThreads, metadata);
  const items = (id: string, subprojectsSupported: boolean) =>
    withThreadNestingMenuItems(
      [{ id: "rename", label: "Rename" }],
      resolveThreadNestingMenuState({
        thread: modeThreads.find((t) => t.id === id)!,
        forest: modeForest,
        supported: true,
        subprojectsSupported,
      }),
    ).map((item) => item.id);

  it("offers the way out for a subproject and the way back for a nested worker", () => {
    expect(items("child", true)).toContain("subproject-off");
    expect(items("child", true)).not.toContain("subproject-on");
    expect(items("grand", true)).toContain("subproject-on");
  });

  it("offers neither on a top-level thread or a host without subprojects", () => {
    for (const ids of [items("other", true), items("child", false)]) {
      expect(ids).not.toContain("subproject-on");
      expect(ids).not.toContain("subproject-off");
    }
  });
});
