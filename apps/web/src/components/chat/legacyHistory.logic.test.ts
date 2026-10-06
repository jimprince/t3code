import { describe, expect, it } from "vite-plus/test";

import {
  describeLegacyRecord,
  formatLegacyTimestamp,
  legacyHistorySectionLabel,
  orderLegacyHistorySections,
} from "./legacyHistory.logic";

describe("orderLegacyHistorySections", () => {
  it("reads messages first and provenance last, without duplicates", () => {
    expect(
      orderLegacyHistorySections(["provenance", "diffs", "thread", "messages", "diffs", "turns"]),
    ).toEqual(["messages", "turns", "diffs", "thread", "provenance"]);
  });

  it("returns nothing when the thread has no history", () => {
    expect(orderLegacyHistorySections([])).toEqual([]);
  });
});

describe("legacyHistorySectionLabel", () => {
  it("names V1 turns as checkpoints", () => {
    expect(legacyHistorySectionLabel("turns")).toBe("Checkpoints");
  });
});

describe("formatLegacyTimestamp", () => {
  it("trims ISO timestamps to the minute and keeps other values", () => {
    expect(formatLegacyTimestamp("2026-05-01T09:30:12.000Z")).toBe("2026-05-01 09:30");
    expect(formatLegacyTimestamp("yesterday")).toBe("yesterday");
    expect(formatLegacyTimestamp(null)).toBeNull();
  });
});

describe("describeLegacyRecord", () => {
  it("reads V1 message rows", () => {
    expect(
      describeLegacyRecord(
        "messages",
        {
          message_id: "m1",
          role: "assistant",
          text: "Done",
          is_streaming: 0,
          created_at: "2026-05-01T09:30:12.000Z",
        },
        0,
      ),
    ).toEqual({
      key: "m1",
      label: "assistant",
      detail: null,
      at: "2026-05-01 09:30",
      body: "Done",
    });
  });

  it("reads bundle-shaped camelCase messages", () => {
    const row = describeLegacyRecord(
      "messages",
      { messageId: "m2", role: "user", text: "Hi", createdAt: "2026-05-01 10:00:00" },
      1,
    );
    expect(row.key).toBe("m2");
    expect(row.at).toBe("2026-05-01 10:00");
  });

  it("falls back to the index when a record carries no id", () => {
    expect(describeLegacyRecord("messages", { role: "user" }, 4).key).toBe("message-4");
  });

  it("summarises a checkpoint with its files", () => {
    const row = describeLegacyRecord(
      "turns",
      {
        turn_id: "t1",
        state: "completed",
        checkpoint_turn_count: 3,
        checkpoint_ref: "refs/checkpoints/3",
        checkpoint_status: "ready",
        checkpoint_files_json: JSON.stringify([
          { path: "src/a.ts", additions: 2, deletions: 1 },
          { path: "src/b.ts" },
        ]),
        completed_at: "2026-05-01T09:31:00.000Z",
      },
      0,
    );
    expect(row.label).toBe("Checkpoint 3");
    expect(row.detail).toBe("completed · ready · refs/checkpoints/3 · 2 files");
    expect(row.body).toBe("src/a.ts +2 -1\nsrc/b.ts");
    expect(row.at).toBe("2026-05-01 09:31");
  });

  it("labels diffs by their turn range and keeps the patch body", () => {
    const row = describeLegacyRecord(
      "diffs",
      { from_turn_count: 1, to_turn_count: 2, diff: "@@ -1 +1 @@" },
      0,
    );
    expect(row.label).toBe("Turns 1 to 2");
    expect(row.body).toBe("@@ -1 +1 @@");
  });

  it("decodes tool payload JSON for display", () => {
    const row = describeLegacyRecord(
      "tools",
      {
        activity_id: "a1",
        kind: "tool.completed",
        tone: "tool",
        summary: "Ran bash",
        payload_json: '{"command":"ls"}',
      },
      0,
    );
    expect(row.label).toBe("Ran bash");
    expect(row.detail).toBe("tool.completed · tool");
    expect(row.body).toBe('{\n  "command": "ls"\n}');
  });

  it("marks implemented plans", () => {
    const row = describeLegacyRecord(
      "plans",
      { plan_id: "p1", plan_markdown: "# Plan", implemented_at: "2026-05-02T00:00:00.000Z" },
      0,
    );
    expect(row.detail).toBe("implemented");
    expect(row.body).toBe("# Plan");
  });

  it("reads goals from a stored goal_json string and from a bundle goal object", () => {
    expect(
      describeLegacyRecord(
        "goals",
        { threadId: "t", goalJson: JSON.stringify({ objective: "Ship it", status: "active" }) },
        0,
      ),
    ).toMatchObject({ label: "Goal", detail: "active", body: "Ship it" });
    expect(
      describeLegacyRecord("goals", { goal: { objective: "Fix it", status: "complete" } }, 1),
    ).toMatchObject({ detail: "complete", body: "Fix it" });
  });

  it("keeps an unrecognised goal readable as JSON", () => {
    expect(describeLegacyRecord("goals", { goal: { note: "x" } }, 0).body).toBe(
      '{\n  "note": "x"\n}',
    );
  });

  it("names provenance records by shape", () => {
    const label = (record: Record<string, unknown>) =>
      describeLegacyRecord("provenance", record, 0).label;
    expect(label({ kind: "thread.forked", payload: {} })).toBe("Forked");
    expect(label({ legacyBundleVersion: 1 })).toBe("V1 bundle");
    expect(label({ attachmentMap: {} })).toBe("Attachment map");
    expect(label({ metadata: {} })).toBe("Source metadata");
    expect(label({ sourceThread: {} })).toBe("Source thread");
    expect(label({})).toBe("Provenance");
  });

  it("shows the thread row's title, branch and worktree", () => {
    const row = describeLegacyRecord(
      "thread",
      { thread_id: "t1", title: "Old work", branch: "feat/x", worktree_path: "/w/x" },
      0,
    );
    expect(row.label).toBe("Old work");
    expect(row.detail).toBe("feat/x · /w/x");
  });
});
