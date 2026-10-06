import { CommandId, EnvironmentId, ThreadId } from "@t3tools/contracts";
import { supervisionForest } from "@t3tools/client-runtime/state/fork-nesting";
import { expect, it } from "vite-plus/test";
import { supervisionDragIntent, canSupervise } from "./supervisionDragIntent";
import { makeThreadFixture } from "../../test-fixtures";
import type { SidebarListItem } from "../Sidebar.logic";
import { planSupervisionDrop } from "./supervisionDrop.logic";

it("requires explicit nesting intent and rejects cycles", () => {
  const threads = ["a", "b"].map((id) =>
    makeThreadFixture({ environmentId: EnvironmentId.make("env"), id: ThreadId.make(id) }),
  );
  const forest = supervisionForest(threads);
  const input = { sourceKey: "env:a", overKey: "env:b", forest };
  expect(supervisionDragIntent({ ...input, previous: { kind: "reorder" }, dx: 11 })).toEqual({
    kind: "reorder",
  });
  const nested = supervisionDragIntent({ ...input, previous: { kind: "reorder" }, dx: 12 });
  expect(nested).toEqual({ kind: "nest", parentKey: "env:b" });
  expect(supervisionDragIntent({ ...input, previous: nested, dx: 7 })).toEqual(nested);
  expect(supervisionDragIntent({ ...input, previous: nested, dx: 5 })).toEqual({ kind: "reorder" });
  expect(canSupervise(forest, "env:a", "env:a")).toBe(false);
  expect(canSupervise(forest, "env:a", "missing")).toBe(false);
});

it("moves a nested child to the top level when dropped on a non-sibling", () => {
  const environmentId = EnvironmentId.make("env");
  const threads = ["p", "q", "c", "d"].map((id) =>
    makeThreadFixture({ environmentId, id: ThreadId.make(id) }),
  );
  const metadata = [
    { threadId: "c", parentThreadId: "p" },
    { threadId: "d", parentThreadId: "q" },
  ].map((row) => ({ ...row, environmentId, remoteParent: null }) as never);
  const forest = supervisionForest(threads, metadata);
  const items: SidebarListItem[] = [
    { kind: "marker", marker: "pinned-divider" },
    ...["env:p", "env:c", "env:q", "env:d"].map((key) => ({
      kind: "thread" as const,
      key,
      section: "active" as const,
    })),
  ];
  const commandId = CommandId.make("cmd");
  const plan = planSupervisionDrop({
    forest,
    items,
    intent: { kind: "reorder" },
    sourceKey: "env:c",
    overKey: "env:d",
    commandId,
  });
  expect(plan.handled).toBe(true);
  expect(plan.command?.input).toMatchObject({
    threadId: "c",
    parentThreadId: null,
    section: "active",
    pinned: false,
  });
});
