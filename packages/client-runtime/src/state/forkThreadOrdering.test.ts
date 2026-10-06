import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";
import { presentThreadShell } from "./models.ts";
import { v2ThreadShell } from "./orchestrationV2TestFixtures.ts";
import {
  planSupervisionMove,
  supervisionMoveAvailability,
  supervisionOrderSiblings,
  supervisionOrderReady,
} from "./forkThreadOrdering.ts";

const readyHosts = new Set(["child-host", "other-host"]);
const thread = (id: string, environment = "child-host", order = "m") => ({
  ...presentThreadShell(EnvironmentId.make(environment), {
    ...v2ThreadShell,
    id: ThreadId.make(id),
  }),
  activeOrderKey: order,
});
it("moves only direct siblings on their own host while their remote parent is disconnected", () => {
  const first = thread("first", "child-host", "f");
  const second = thread("second", "child-host", "t");
  const unrelated = thread("unrelated");
  const foreign = thread("first", "other-host");
  const pinned = { ...thread("pinned"), pinnedAt: "2026-10-05T00:00:00Z" };
  const threads = [first, unrelated, foreign, pinned, second];
  const metadata = threads.map((t) => ({
    environmentId: t.environmentId,
    threadId: t.id,
    parentThreadId: null,
    remoteParent: {
      environmentId: "disconnected-host",
      threadId: ThreadId.make(t === unrelated ? "different" : "parent"),
    },
  }));
  expect(supervisionOrderSiblings(threads, metadata, first, readyHosts).map((t) => t.id)).toEqual([
    "first",
    "second",
  ]);
  const move = planSupervisionMove(threads, metadata, first, "down", readyHosts)!;
  const moved = threads.map((t) => ({
    ...t,
    activeOrderKey:
      move.find((a) => a.id === `${t.environmentId}:${t.id}`)?.orderKey ?? t.activeOrderKey,
  }));
  expect(supervisionOrderSiblings(moved, metadata, first, readyHosts).map((t) => t.id)).toEqual([
    "second",
    "first",
  ]);
  expect(planSupervisionMove(threads, metadata, first, "up", readyHosts)).toBeNull();
  const availability = supervisionMoveAvailability(
    [first, second, unrelated, foreign, pinned],
    metadata,
    readyHosts,
  );
  expect(availability.get("child-host:first")).toEqual({ canMoveUp: false, canMoveDown: true });
  expect(availability.get("other-host:first")).toEqual({ canMoveUp: false, canMoveDown: false });
});
it("keeps missing local parents distinct from remote descriptors and excludes settled siblings", () => {
  const root = thread("root");
  const local = thread("local");
  const remote = thread("remote");
  const settled = { ...thread("settled"), settledOverride: "settled" as const };
  const metadata = [
    {
      environmentId: local.environmentId,
      threadId: local.id,
      parentThreadId: ThreadId.make("parent"),
    },
    {
      environmentId: remote.environmentId,
      threadId: remote.id,
      parentThreadId: null,
      remoteParent: { environmentId: "child-host", threadId: ThreadId.make("parent") },
    },
  ];
  const threads = [root, local, remote, settled];
  for (const t of [root, local, remote])
    expect(supervisionOrderSiblings(threads, metadata, t, readyHosts).map((s) => s.id)).toEqual([t.id]);
});

it("blocks moves and resets until the child's own host metadata is ready, including empty root metadata", () => {
  const first = thread("first", "child-host", "f"), second = thread("second", "child-host", "t");
  const unavailable = new Set(["other-host"]);
  expect(supervisionOrderReady(first, unavailable)).toBe(false);
  expect(supervisionOrderSiblings([first, second], [], first, unavailable)).toEqual([]);
  expect(planSupervisionMove([first, second], [], first, "down", unavailable)).toBeNull();
  expect(supervisionMoveAvailability([first, second], [], unavailable).size).toBe(0);
  expect(supervisionOrderReady(first, readyHosts)).toBe(true);
  expect(planSupervisionMove([first, second], [], first, "down", readyHosts)).not.toBeNull();
  expect(supervisionMoveAvailability([first, second], [], readyHosts).get("child-host:first")?.canMoveDown).toBe(true);
});
