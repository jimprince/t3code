// @effect-diagnostics nodeBuiltinImport:off -- Exercises real temporary files and symlink refusal.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import {
  FEED_FILES,
  feedRoutines,
  findingsReceipts,
  readFeed,
  type FeedFile,
  type FeedRead,
} from "./feeds.ts";

const NOW = "2026-10-11T06:00:00.000Z";
const ENV = EnvironmentId.make("host-environment");
describe("allowlisted owner feeds", () => {
  it("refuses arbitrary filenames and symlinks outside the configured directory", async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "harness-feeds-"));
    try {
      const directory = NodePath.join(root, "allowed");
      await NodeFSP.mkdir(directory);
      await NodeFSP.writeFile(
        NodePath.join(root, "outside.json"),
        JSON.stringify({ generated_at: NOW, secret: "outside" }),
      );
      await NodeFSP.symlink(
        NodePath.join(root, "outside.json"),
        NodePath.join(directory, "health.json"),
      );
      expect(await readFeed(directory, "../outside.json", NOW, 300_000)).toMatchObject({
        source: { status: "refused" },
        value: null,
      });
      expect(await readFeed(directory, "health.json", NOW, 300_000)).toMatchObject({
        source: { status: "refused" },
        value: null,
      });
    } finally {
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });
  it("validates timestamps, marks stale sources and bounds file reads", async () => {
    const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "harness-feeds-"));
    try {
      await NodeFSP.writeFile(
        NodePath.join(directory, "health.json"),
        JSON.stringify({ generated_at: "2026-10-11T00:00:00.000Z" }),
      );
      expect((await readFeed(directory, "health.json", NOW, 300_000)).source).toMatchObject({
        status: "stale",
        observedAt: "2026-10-11T00:00:00.000Z",
        readAt: NOW,
      });
      await NodeFSP.writeFile(
        NodePath.join(directory, "health.json"),
        JSON.stringify({ generated_at: "yesterday" }),
      );
      expect(await readFeed(directory, "health.json", NOW, 300_000)).toMatchObject({
        source: { status: "unavailable" },
        value: null,
      });
      await NodeFSP.writeFile(
        NodePath.join(directory, "health.json"),
        "x".repeat(2 * 1024 * 1024 + 1),
      );
      expect(await readFeed(directory, "health.json", NOW, 300_000)).toMatchObject({
        source: { status: "refused" },
        value: null,
      });
    } finally {
      await NodeFSP.rm(directory, { recursive: true, force: true });
    }
  });
  it("keeps missing feeds unknown with explicit disabled and not-shown checks", async () => {
    const feeds = new Map<FeedFile, FeedRead>();
    for (const filename of FEED_FILES)
      feeds.set(filename, await readFeed(null, filename, NOW, 300_000));
    const rows = feedRoutines(feeds, ENV, {}, 10);
    expect(rows.find((row) => row.name === "Reliability health")).toMatchObject({
      state: "not shown yet",
      sourceStale: true,
      errorsPerRun: { average: null },
      liveness: "unknown",
    });
    expect(rows.find((row) => row.name === "#240 watchdog W: DISABLED")).toMatchObject({
      state: "disabled",
      nextExpectedRun: null,
      lateness: { overdue: false },
    });
  });
  it("joins canaries by exact route/thread, requires scoped links and does not invent missed probes", async () => {
    const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "harness-feeds-"));
    try {
      await NodeFSP.writeFile(
        NodePath.join(directory, "canary-policy.json"),
        JSON.stringify({
          schemaVersion: 1,
          accepted_at: NOW,
          enabled: true,
          routes: [{ host: "remote", account: "codex", threadId: "probe" }],
        }),
      );
      await NodeFSP.writeFile(
        NodePath.join(directory, "canary-state.json"),
        JSON.stringify({
          routes: {
            "remote:codex": {
              threadId: "probe",
              checked_at: NOW,
              consecutive_failures: 3,
              status: "ok",
              readback: {
                thread: "probe",
                account: "codex",
                account_exact: true,
                checked_at: NOW,
                activeRunId: null,
                runs: [
                  ...Array.from({ length: 110 }, (_, index) => ({
                    id: `old-${index}`,
                    providerInstanceId: "codex",
                    requestedAt: "2026-10-10T05:00:00.000Z",
                    startedAt: "2026-10-10T05:00:00.000Z",
                    completedAt: "2026-10-10T05:01:00.000Z",
                    status: "completed",
                  })),
                  {
                    id: "foreign-account",
                    providerInstanceId: "other-account",
                    requestedAt: NOW,
                    startedAt: NOW,
                    completedAt: NOW,
                    status: "completed",
                  },
                  {
                    id: "probe-run",
                    providerInstanceId: "codex",
                    requestedAt: NOW,
                    startedAt: NOW,
                    completedAt: NOW,
                    status: "completed",
                    user_message_id: "probe-message",
                  },
                ],
              },
            },
          },
        }),
      );
      await NodeFSP.writeFile(
        NodePath.join(directory, "canary-tick-readback.json"),
        JSON.stringify({
          checked_at: NOW,
          enabled: true,
          plans: [
            {
              host: "remote",
              account: "codex",
              threadId: "probe",
              action: "natural-start-proves-busy",
              cadence_seconds: 900,
            },
          ],
        }),
      );
      const feeds = new Map<FeedFile, FeedRead>();
      for (const filename of FEED_FILES)
        feeds.set(filename, await readFeed(directory, filename, NOW, 300_000));
      const unscoped = feedRoutines(feeds, ENV, {}, 10).find(
        (row) => row.key === "canary:remote:codex",
      )!;
      expect(unscoped.history[0]).toMatchObject({
        key: "probe-run",
        outcome: "completed",
        errorCount: null,
        runtimeErrorCount: null,
        threads: [],
      });
      const scoped = feedRoutines(
        feeds,
        ENV,
        { remote: EnvironmentId.make("remote-environment") },
        10,
      ).find((row) => row.key === "canary:remote:codex")!;
      expect(scoped).toMatchObject({
        lifecycle: "standing",
        context: "persistent",
        lateness: { state: "event-driven", overdue: null },
        liveness: "not currently live",
      });
      expect(scoped.history[0]?.threads[0]).toMatchObject({
        environmentId: "remote-environment",
        threadId: "probe",
      });
    } finally {
      await NodeFSP.rm(directory, { recursive: true, force: true });
    }
  });
  it("admits findings only with exact keys and complete fresh receipts", () => {
    const feed: FeedRead = {
      source: {
        key: "run-receipts.json",
        readAt: NOW,
        observedAt: NOW,
        status: "available",
        evidence: "owner",
      },
      value: {
        receipts: [
          {
            routineKey: "a",
            runKey: "run-1",
            observedAt: NOW,
            findingsCount: 7,
            coverage: "complete",
          },
          {
            routineKey: "b",
            runKey: "run-2",
            observedAt: NOW,
            findingsCount: 0,
            coverage: "partial",
          },
        ],
      },
    };
    expect(findingsReceipts(feed).get("a\0run-1")).toBe(7);
    expect(findingsReceipts(feed).has("b\0run-2")).toBe(false);
    expect(findingsReceipts({ ...feed, source: { ...feed.source, status: "stale" } }).size).toBe(0);
  });
});
