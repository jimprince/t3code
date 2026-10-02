import { DateTime } from "effect";
import { expect, it } from "vite-plus/test";
import { threadShell } from "../src/v2/reads.js";
import { RemoteEnvironmentClient } from "../src/client.js";
import { streamThreadSnapshot, summarizeThreadQueue } from "../src/threadSnapshot.js";
import { at, projection, shell } from "./v2-fixture.js";
import type { SavedEnvironment } from "../src/types.js";

const threads = Array.from({ length: 11 }, (_, i) =>
  threadShell(
    shell({
      id: `worker-${i}`,
      activeRunId: i === 0 ? "active" : null,
      latestRunStartedAt: i === 0 ? DateTime.makeUnsafe(at()) : null,
    }),
  ),
);
it("bounds concurrent queue reads and waits for output before admitting another batch", async () => {
  const pending: (() => void)[] = [];
  const started: string[] = [];
  const written: string[] = [];
  const blockers: (() => void)[] = [];
  const work = streamThreadSnapshot(
    threads,
    async (id) => {
      started.push(id);
      await new Promise<void>((resolve) => pending.push(resolve));
      return { queuedCount: 1, heldCount: 1, oldestQueuedAt: at() };
    },
    async (row) => {
      written.push(row.id);
      await new Promise<void>((resolve) => blockers.push(resolve));
    },
    { concurrency: 2 },
  );
  expect(started).toHaveLength(2);
  while (written.length < threads.length) {
    pending.splice(0).forEach((resolve) => resolve());
    // Drain promise continuations; no wall-clock sleeps or server polling.
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(started.length - written.length).toBeLessThanOrEqual(2);
    expect(started.length).toBeLessThanOrEqual(Math.ceil(written.length / 2) * 2);
    blockers.splice(0).forEach((resolve) => resolve());
    for (let i = 0; i < 10; i++) await Promise.resolve();
  }
  blockers.splice(0).forEach((resolve) => resolve());
  await work;
  expect(written).toEqual(threads.map((thread) => thread.id));
});
it("isolates rejected and cancelled reads without inventing empty queues", async () => {
  const rows: unknown[] = [];
  await streamThreadSnapshot(
    threads.slice(0, 3),
    async (id, signal) => {
      if (id === "worker-0") throw new Error("queue unavailable");
      if (id === "worker-1")
        await new Promise((_, reject) =>
          signal.addEventListener("abort", () => reject(signal.reason), { once: true }),
        );
      return { queuedCount: 0, heldCount: 0, oldestQueuedAt: null };
    },
    async (row) => {
      rows.push(row);
    },
    { timeoutMs: 5 },
  );
  expect(rows).toMatchObject([
    { queuedCount: null, heldCount: null, oldestQueuedAt: null, queueError: "queue unavailable" },
    { queuedCount: null, queueError: "Queue read timed out after 5 ms" },
    { queuedCount: 0, heldCount: 0, oldestQueuedAt: null },
  ]);
});
it("counts queued/held runs and their oldest request through one read-only connection", async () => {
  const template = { ...projection().runs[0]!, startedAt: at(), completedAt: null };
  const data = projection({
    runs: [
      { ...template, id: "held", status: "queued", queueHeld: true, requestedAt: at(2) },
      { ...template, id: "queued", status: "queued", requestedAt: at(1) },
      { ...template, id: "done", status: "completed", queueHeld: true, requestedAt: at(0) },
    ],
  });
  expect(summarizeThreadQueue(data)).toEqual({
    queuedCount: 2,
    heldCount: 1,
    oldestQueuedAt: at(1),
  });
  let connections = 0,
    disposed = false;
  const calls: string[] = [];
  const client = new RemoteEnvironmentClient(
    { name: "fixture", wsBaseUrl: "ws://fixture" } as SavedEnvironment,
    {
      descriptorFactory: async () => ({
        environmentId: "fixture",
        label: "Fixture",
        platform: { os: "linux", arch: "x64" },
        serverVersion: "fixture",
        capabilities: {},
      }),
      rpcFactory: () => {
        connections++;
        return {
          subscribeShellSnapshot: async <T>() => ({ kind: "snapshot", snapshot: { threads } }) as T,
          subscribeThreadSnapshot: async <T>() => data as T,
          request: async <T>(method: string) => {
            calls.push(method);
            return (method === "getArchivedShellSnapshot" ? { threads: [] } : data) as T;
          },
          dispose: async () => {
            disposed = true;
          },
        };
      },
    },
  );
  const rows: unknown[] = [];
  await client.streamThreadsJson(
    async (row) => {
      rows.push(row);
    },
    { activeOnly: true },
  );
  expect(connections).toBe(1);
  expect(disposed).toBe(true);
  expect(calls).toEqual(["getArchivedShellSnapshot", "getThreadProjection"]);
  expect(rows).toHaveLength(11);
  expect(rows[0]).toMatchObject({
    activeRunId: "active",
    latestRunStartedAt: at(),
    queuedCount: 2,
    heldCount: 1,
  });
  expect(rows[1]).toMatchObject({
    queuedCount: null,
    queueError: expect.stringContaining("skipped"),
  });
});
