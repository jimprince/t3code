import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { presentThreadShell } from "./state/models.ts";
import { v2ThreadShell } from "./state/orchestrationV2TestFixtures.ts";
import { connectedSupervisionParents, supervisionKey } from "./state/forkNesting.ts";
import { groupSupervisionChildInputAttention } from "./childAttention.ts";

const thread = (id: string, environment = "local") =>
  presentThreadShell(EnvironmentId.make(environment), { ...v2ThreadShell, id: ThreadId.make(id) });
const link = (id: string, parent: string | null, environmentId = "local") => ({
  environmentId,
  threadId: ThreadId.make(id),
  parentThreadId: parent === null ? null : ThreadId.make(parent),
});
const waiting = (id: string, environment = "local") => ({
  ...thread(id, environment),
  hasPendingUserInput: true,
  settledOverride: null,
});
const group = (
  threads: Parameters<typeof connectedSupervisionParents>[0] &
    Parameters<typeof groupSupervisionChildInputAttention>[0],
  metadata: Parameters<typeof connectedSupervisionParents>[1],
) => groupSupervisionChildInputAttention(threads, connectedSupervisionParents(threads, metadata));

describe("organizational child-input attention", () => {
  it("groups every depth in shell order and follows sidecar reparenting without changing parent status", () => {
    const root = thread("root"),
      middle = thread("middle"),
      a = waiting("a"),
      b = waiting("b");
    const threads = [root, middle, b, a];
    const links = [link("middle", "root"), link("a", "middle"), link("b", "root")];
    const groups = group(threads, links);
    expect(groups.get("local:root")?.map((t) => t.id)).toEqual(["b", "a"]);
    expect(groups.get("local:middle")?.map((t) => t.id)).toEqual(["a"]);
    expect(root.hasPendingUserInput).toBe(false);
    expect(group(threads, [link("a", "root")]).has("local:middle")).toBe(false);
  });
  it("stops at settled, archived, deleted and absent ancestors and never follows execution lineage", () => {
    const root = thread("root"),
      middle = thread("middle"),
      child = waiting("child");
    const links = [link("middle", "root"), link("child", "middle")];
    for (const barrier of [
      { ...middle, settledOverride: "settled" as const },
      { ...middle, archivedAt: "date" },
      { ...middle, deletedAt: "date" },
    ]) {
      const parents = new Map([
        ["local:child", "local:middle"],
        ["local:middle", "local:root"],
      ]);
      expect(groupSupervisionChildInputAttention([root, barrier, child], parents).size).toBe(0);
    }
    expect(group([root, child], links).size).toBe(0);
    const native = { ...child, lineage: { ...child.lineage, parentThreadId: root.id } };
    expect(group([root, native], []).size).toBe(0);
    for (const excluded of [
      { ...child, settledOverride: "settled" as const },
      { ...child, archivedAt: "date" },
      { ...child, deletedAt: "date" },
    ])
      expect(group([root, middle, excluded], links).size).toBe(0);
  });
  it("uses explicit resolved remote edges and cuts cycles with scoped identities", () => {
    const root = thread("same"),
      remote = waiting("same", "remote");
    expect(group([root, remote], [link("same", "same", "remote")]).size).toBe(0);
    const links = [
      {
        ...link("same", null, "remote"),
        remoteParent: { environmentId: "local", threadId: root.id },
      },
    ];
    expect(
      group([root, remote], links)
        .get(supervisionKey("local", "same"))
        ?.map((t) => t.environmentId),
    ).toEqual(["remote"]);
    expect(group([remote], links).size).toBe(0);
    expect(group([waiting("a"), thread("b")], [link("a", "b"), link("b", "a")]).size).toBe(0);
  });
});
