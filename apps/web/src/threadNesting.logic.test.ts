import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  applySidebarThreadNesting,
  isNestedUnder,
  isThreadNestingMenuId,
  listNestedThreads,
  nestUnderMenuTarget,
  resolveNestedDraftParent,
  resolveNestedThreadKeys,
  resolveThreadNestingMenuState,
  resolveViewedNestedThread,
  selectNestParentCandidates,
  withThreadNestingMenuItems,
} from "./threadNesting.logic";

const envA = EnvironmentId.make("env-a");
const envB = EnvironmentId.make("env-b");
const projectA = ProjectId.make("project-a");
const projectB = ProjectId.make("project-b");

interface TestThread {
  readonly id: ThreadId;
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly parentThreadId?: ThreadId | null;
  readonly archivedAt: string | null;
  readonly hasPendingApprovals: boolean;
  readonly hasPendingUserInput: boolean;
  readonly session?: EnvironmentThreadShell["session"];
  readonly backgroundLiveness?: "working" | "monitoring" | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly title: string;
}

function thread(id: string, overrides: Partial<Omit<TestThread, "id">> = {}): TestThread {
  return {
    id: ThreadId.make(id),
    environmentId: envA,
    projectId: projectA,
    parentThreadId: null,
    archivedAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    title: id,
    ...overrides,
  };
}

const parentId = ThreadId.make("parent");
const ids = (threads: ReadonlyArray<TestThread>) => threads.map((entry) => entry.id);

describe("resolveNestedThreadKeys", () => {
  it("nests a thread only under a live, top-level parent in the same environment and project", () => {
    const keys = resolveNestedThreadKeys([
      thread("parent"),
      thread("child", { parentThreadId: parentId }),
      thread("other-project", { parentThreadId: parentId, projectId: projectB }),
      thread("missing-parent", { parentThreadId: ThreadId.make("gone") }),
    ]);
    expect([...keys]).toHaveLength(1);
    expect([...keys][0]).toContain("child");
  });

  it("returns a thread to the sidebar when its parent is archived", () => {
    const keys = resolveNestedThreadKeys([
      thread("parent", { archivedAt: "2026-09-02T00:00:00.000Z" }),
      thread("child", { parentThreadId: parentId }),
    ]);
    expect(keys.size).toBe(0);
  });

  it("never matches a parent id from another environment", () => {
    const keys = resolveNestedThreadKeys([
      thread("parent", { environmentId: envB }),
      thread("child", { parentThreadId: parentId }),
    ]);
    expect(keys.size).toBe(0);
  });

  it("does not hide a child whose parent is itself nested, so a chain cannot strand it", () => {
    const keys = resolveNestedThreadKeys([
      thread("a", { parentThreadId: ThreadId.make("b") }),
      thread("b", { parentThreadId: ThreadId.make("a") }),
    ]);
    expect(keys.size).toBe(0);
  });
});

describe("applySidebarThreadNesting", () => {
  it("returns the input untouched when nothing is nested", () => {
    const threads = [thread("a"), thread("b")];
    expect(applySidebarThreadNesting(threads)).toBe(threads);
  });

  it("hides nested threads and rolls their pending approval and input into the parent", () => {
    const result = applySidebarThreadNesting([
      thread("parent"),
      thread("approval", { parentThreadId: parentId, hasPendingApprovals: true }),
      thread("input", { parentThreadId: parentId, hasPendingUserInput: true }),
      thread("sibling"),
    ]);
    expect(ids(result)).toEqual(["parent", "sibling"]);
    expect(result[0]).toMatchObject({ hasPendingApprovals: true, hasPendingUserInput: true });
    expect(result[1]).toMatchObject({ hasPendingApprovals: false, hasPendingUserInput: false });
  });

  it("ignores attention on archived children", () => {
    const result = applySidebarThreadNesting([
      thread("parent"),
      thread("quiet", { parentThreadId: parentId }),
      thread("archived", {
        parentThreadId: parentId,
        archivedAt: "2026-09-02T00:00:00.000Z",
        hasPendingApprovals: true,
      }),
    ]);
    expect(result[0]).toMatchObject({ id: parentId, hasPendingApprovals: false });
  });

  it("shows a working or monitoring sub-agent as the parent's background work", () => {
    const running = { status: "running" } as EnvironmentThreadShell["session"];
    const [idleParent] = applySidebarThreadNesting([
      thread("parent"),
      thread("worker", { parentThreadId: parentId, session: running }),
      thread("watcher", { parentThreadId: parentId, backgroundLiveness: "monitoring" }),
    ]);
    expect(idleParent).toMatchObject({ backgroundLiveness: "working" });

    const [monitoringParent] = applySidebarThreadNesting([
      thread("parent"),
      thread("watcher", { parentThreadId: parentId, backgroundLiveness: "monitoring" }),
    ]);
    expect(monitoringParent).toMatchObject({ backgroundLiveness: "monitoring" });

    const busyParent = thread("parent", { backgroundLiveness: "working" });
    const [unchanged] = applySidebarThreadNesting([
      busyParent,
      thread("watcher", { parentThreadId: parentId, backgroundLiveness: "monitoring" }),
    ]);
    expect(unchanged).toBe(busyParent);
  });

  it("does not show an idle or archived sub-agent as work", () => {
    const [parent] = applySidebarThreadNesting([
      thread("parent"),
      thread("idle", { parentThreadId: parentId, session: { status: "ready" } as never }),
      thread("archived", {
        parentThreadId: parentId,
        archivedAt: "2026-09-02T00:00:00.000Z",
        backgroundLiveness: "working",
      }),
    ]);
    expect(parent?.backgroundLiveness ?? null).toBeNull();
  });

  it("does not roll attention into a same-id thread in another environment", () => {
    const result = applySidebarThreadNesting([
      thread("parent"),
      thread("parent", { environmentId: envB }),
      thread("child", { parentThreadId: parentId, hasPendingApprovals: true }),
    ]);
    expect(result.map((entry) => [entry.environmentId, entry.hasPendingApprovals])).toEqual([
      [envA, true],
      [envB, false],
    ]);
  });
});

describe("listNestedThreads", () => {
  it("lists unarchived children of the parent in that environment, oldest first", () => {
    const result = listNestedThreads(
      [
        thread("late", { parentThreadId: parentId, createdAt: "2026-09-03T00:00:00.000Z" }),
        thread("early", { parentThreadId: parentId, createdAt: "2026-09-02T00:00:00.000Z" }),
        thread("archived", { parentThreadId: parentId, archivedAt: "2026-09-04T00:00:00.000Z" }),
        thread("elsewhere", { parentThreadId: parentId, environmentId: envB }),
        thread("unrelated"),
      ],
      { environmentId: envA, threadId: parentId },
    );
    expect(ids(result)).toEqual(["early", "late"]);
  });
});

describe("selectNestParentCandidates", () => {
  const subject = thread("subject");

  it("offers top-level, unarchived threads in the same environment and project, newest first", () => {
    const result = selectNestParentCandidates(subject, [
      subject,
      thread("old", { updatedAt: "2026-09-02T00:00:00.000Z" }),
      thread("new", { updatedAt: "2026-09-05T00:00:00.000Z" }),
      thread("archived", { archivedAt: "2026-09-03T00:00:00.000Z" }),
      thread("nested", { parentThreadId: ThreadId.make("new") }),
      thread("other-project", { projectId: projectB }),
      thread("other-env", { environmentId: envB }),
    ]);
    expect(ids(result)).toEqual(["new", "old"]);
  });

  it("excludes the current parent and honors the limit", () => {
    const nested = thread("subject", { parentThreadId: ThreadId.make("current") });
    const result = selectNestParentCandidates(
      nested,
      [
        nested,
        thread("current"),
        thread("a", { updatedAt: "2026-09-03T00:00:00.000Z" }),
        thread("b", { updatedAt: "2026-09-02T00:00:00.000Z" }),
      ],
      1,
    );
    expect(ids(result)).toEqual(["a"]);
  });

  it("offers nothing when the thread already has children, archived ones included", () => {
    const result = selectNestParentCandidates(subject, [
      subject,
      thread("candidate"),
      thread("child", { parentThreadId: subject.id, archivedAt: "2026-09-02T00:00:00.000Z" }),
    ]);
    expect(result).toEqual([]);
  });
});

describe("resolveNestedDraftParent", () => {
  const intent = { environmentId: envA, parentThreadId: parentId };
  const draft = { environmentId: envA, projectId: projectA };

  it("resolves the parent while the draft still matches it", () => {
    expect(resolveNestedDraftParent({ intent, draft, threads: [thread("parent")] })?.id).toBe(
      parentId,
    );
  });

  it("drops the parent when the draft moved or the parent can no longer take children", () => {
    const cases = [
      { draft: { environmentId: envB, projectId: projectA }, threads: [thread("parent")] },
      { draft: { environmentId: envA, projectId: projectB }, threads: [thread("parent")] },
      { draft, threads: [thread("parent", { archivedAt: "2026-09-02T00:00:00.000Z" })] },
      { draft, threads: [thread("parent", { parentThreadId: ThreadId.make("other") })] },
      { draft, threads: [] },
    ];
    for (const input of cases) {
      expect(resolveNestedDraftParent({ intent, ...input })).toBeNull();
    }
    expect(resolveNestedDraftParent({ intent: null, draft, threads: [thread("parent")] })).toBe(
      null,
    );
  });
});

describe("thread action menu nesting items", () => {
  const baseItems = [
    { id: "new-thread-on-branch", label: "New thread on main" },
    { id: "pin", label: "Pin thread" },
    { id: "rename", label: "Rename thread", separatorBefore: true },
    { id: "delete", label: "Delete" },
  ];

  it("adds nothing when the server does not support nesting", () => {
    const subject = thread("subject");
    const state = resolveThreadNestingMenuState(subject, [subject, thread("parent")], false);
    expect(withThreadNestingMenuItems(baseItems, state)).toBe(baseItems);
  });

  it("places start beside new-thread and placement actions before rename", () => {
    const subject = thread("subject");
    const state = resolveThreadNestingMenuState(subject, [subject, thread("parent")], true);
    const items = withThreadNestingMenuItems(baseItems, state);
    expect(items.map((item) => item.id)).toEqual([
      "new-thread-on-branch",
      "new-nested-thread",
      "pin",
      "nest-under",
      "rename",
      "delete",
    ]);
    const nestUnder = items.find((item) => item.id === "nest-under");
    expect(nestUnder?.children?.map((item) => item.id)).toEqual(["nest-under:parent"]);
    expect(nestUnderMenuTarget("nest-under:parent", state)).toBe(parentId);
    expect(nestUnderMenuTarget("nest-under:unknown", state)).toBeNull();
  });

  it("offers Move to sidebar, and not New thread under, for a nested thread", () => {
    const subject = thread("subject", { parentThreadId: parentId });
    const state = resolveThreadNestingMenuState(subject, [subject, thread("parent")], true);
    const menuIds = withThreadNestingMenuItems(baseItems, state).map((item) => item.id);
    expect(menuIds).toContain("move-to-sidebar");
    expect(menuIds).not.toContain("new-nested-thread");
    expect(isThreadNestingMenuId("move-to-sidebar")).toBe(true);
    expect(isThreadNestingMenuId("nest-under:x")).toBe(true);
    expect(isThreadNestingMenuId("rename")).toBe(false);
  });
});

describe("resolveViewedNestedThread", () => {
  const key = (id: string) => scopedThreadKey(scopeThreadRef(envA, ThreadId.make(id)));
  const nested = [thread("parent"), thread("child", { parentThreadId: parentId })];

  it("returns the open nested thread with its parent's key, so the sidebar can show it there", () => {
    const viewed = resolveViewedNestedThread(nested, key("child"));
    expect(viewed?.thread.id).toBe(ThreadId.make("child"));
    expect(viewed?.parentKey).toBe(key("parent"));
  });

  it("ignores top-level threads, nothing open, and threads whose parent is archived", () => {
    const archivedParent = [
      thread("parent", { archivedAt: "2026-09-02T00:00:00.000Z" }),
      thread("child", { parentThreadId: parentId }),
    ];
    expect(resolveViewedNestedThread(archivedParent, key("child"))).toBeNull();
    expect(resolveViewedNestedThread(nested, key("parent"))).toBeNull();
    expect(resolveViewedNestedThread(nested, null)).toBeNull();
  });
});

describe("isNestedUnder", () => {
  it("matches only a live, top-level parent in the same environment and project", () => {
    const child = thread("child", { parentThreadId: parentId });
    expect(isNestedUnder(child, thread("parent"))).toBe(true);
    expect(isNestedUnder(child, thread("parent", { environmentId: envB }))).toBe(false);
    expect(isNestedUnder(child, thread("parent", { projectId: projectB }))).toBe(false);
    expect(isNestedUnder(child, thread("parent", { archivedAt: "2026-09-02T00:00:00.000Z" }))).toBe(
      false,
    );
    expect(isNestedUnder(child, thread("parent", { parentThreadId: ThreadId.make("top") }))).toBe(
      false,
    );
  });
});
