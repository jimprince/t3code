import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { presentThreadShell } from "./state/models.ts";
import { v2ThreadShell } from "./state/orchestrationV2TestFixtures.ts";
import { groupSupervisionChildInputAttention } from "./childAttention.ts";

const env = EnvironmentId.make("local");
function thread(id: string, parentThreadId: string | null = null) {
  return presentThreadShell(env, {
    ...v2ThreadShell,
    id: ThreadId.make(id),
    parentThreadId,
  } as typeof v2ThreadShell);
}

describe("organizational child-input attention", () => {
  const waiting = (id: string, parent: string) => ({
    ...thread(id, parent),
    hasPendingUserInput: true,
    settledOverride: null,
  });
  it("groups every depth once in shell order and follows reparenting, without changing parent status", () => {
    const root = thread("root"),
      middle = thread("middle", "root"),
      a = waiting("a", "middle"),
      b = waiting("b", "root");
    const groups = groupSupervisionChildInputAttention([root, middle, b, a]);
    expect(groups.get("local:root")?.map((t) => t.id)).toEqual(["b", "a"]);
    expect(groups.get("local:middle")?.map((t) => t.id)).toEqual(["a"]);
    expect(root.hasPendingUserInput).toBe(false);
    expect(
      groupSupervisionChildInputAttention([root, middle, waiting("a", "root")]).has("local:middle"),
    ).toBe(false);
  });
  it("stops at settled, archived, deleted or missing ancestors and ignores execution lineage", () => {
    const root = thread("root"),
      middle = thread("middle", "root"),
      child = waiting("child", "middle");
    for (const barrier of [
      { ...middle, settledOverride: "settled" as const },
      { ...middle, archivedAt: "date" },
      { ...middle, deletedAt: "date" },
    ]) {
      expect(groupSupervisionChildInputAttention([root, barrier, child]).size).toBe(0);
    }
    for (const ineligible of [
      { ...child, settledOverride: "settled" as const },
      { ...child, archivedAt: "date" },
      { ...child, deletedAt: "date" },
    ]) {
      expect(groupSupervisionChildInputAttention([root, middle, ineligible]).size).toBe(0);
    }
    expect(groupSupervisionChildInputAttention([root, child]).size).toBe(0);
    const nativeChild = {
      ...waiting("native", "root"),
      source: { ...child.source, parentThreadId: null },
      lineage: { ...child.lineage, parentThreadId: root.id },
    };
    expect(groupSupervisionChildInputAttention([root, nativeChild]).size).toBe(0);
  });
  it("uses only explicit resolved remote edges and guards cycles", () => {
    const root = thread("root"),
      remote = { ...waiting("worker", "root"), environmentId: EnvironmentId.make("remote") };
    expect(groupSupervisionChildInputAttention([root, remote]).size).toBe(0);
    const linked = {
      ...remote,
      source: {
        ...remote.source,
        parentThreadId: null,
        remoteParent: { environmentId: env, threadId: root.id },
      },
    };
    expect(
      groupSupervisionChildInputAttention([root, linked])
        .get("local:root")
        ?.map((t) => t.id),
    ).toEqual(["worker"]);
    expect(groupSupervisionChildInputAttention([linked]).size).toBe(0);
    const cyclic = groupSupervisionChildInputAttention([waiting("a", "b"), thread("b", "a")]);
    expect(cyclic.get("local:b")?.map((t) => t.id)).toEqual(["a"]);
    expect(cyclic.has("local:a")).toBe(false);
  });
});
