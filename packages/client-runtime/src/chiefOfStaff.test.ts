import { describe, expect, it } from "vite-plus/test";
import {
  EnvironmentId,
  MessageId,
  ThreadId,
  type DashboardAttention,
  type DashboardSnapshot,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { v2Projection, v2ThreadShell } from "./state/orchestrationV2TestFixtures.ts";
import {
  selectScopedChiefOfStaffThread,
  selectChiefOfStaffSummary,
  selectChiefOfStaffThread,
} from "./chiefOfStaff.ts";

const desk = { ...v2ThreadShell, title: "Chief of Staff" };
const operations = { ...desk, id: ThreadId.make("operations"), title: "chief-of-staff Operations" };
const replyAt = DateTime.makeUnsafe("2026-10-12T04:30:00Z");
const userAt = DateTime.makeUnsafe("2026-10-12T04:40:00Z");
const attention = (
  id: string,
  kind: DashboardAttention["kind"] = "decision",
): DashboardAttention => ({
  id,
  kind,
  taskId: id,
  blockingTaskIds: [],
  requestId: null,
  title: id,
  canRespond: true,
  options: [],
  priority: 0,
  url: null,
  threadId: null,
  updatedAt: "2026-10-12T04:30:00Z",
  deadline: null,
  question: id,
  sourceId: "local",
});
const snapshot = (items: readonly DashboardAttention[]): DashboardSnapshot => ({
  revision: 1,
  asOf: "2026-10-12T04:30:00Z",
  sources: [],
  releases: [],
  projects: [
    {
      id: "project",
      rootThreadId: null,
      parentId: null,
      title: "Project",
      utility: false,
      omittedTaskCount: 0,
      workstreams: [],
      tasks: [],
      attention: items,
      sourceIds: [],
    },
  ],
});
const projection = {
  ...v2Projection,
  messages: [
    {
      id: MessageId.make("reply"),
      threadId: desk.id,
      runId: null,
      nodeId: null,
      role: "assistant" as const,
      text: "Ready",
      attachments: [],
      streaming: false,
      createdAt: replyAt,
      updatedAt: replyAt,
      createdBy: "agent" as const,
      creationSource: "provider" as const,
    },
  ],
};

describe("Chief of Staff summary", () => {
  it("discovers the front desk, preserves an explicit choice, and hides unavailable targets", () => {
    expect(selectChiefOfStaffThread([operations, desk], null)).toBe(desk);
    expect(selectChiefOfStaffThread([operations, desk], operations.id)).toBe(operations);
    expect(selectChiefOfStaffThread([desk], ThreadId.make("missing"))).toBeNull();
    expect(selectChiefOfStaffThread([operations], null)).toBeNull();
    expect(selectChiefOfStaffThread([{ ...desk, archivedAt: replyAt }], null)).toBeNull();
    expect(selectChiefOfStaffThread([{ ...desk, deletedAt: replyAt }], null)).toBeNull();
  });
  it("counts every attention row, matching the pinned decision cards", () => {
    expect(
      selectChiefOfStaffSummary({
        thread: desk,
        projection: null,
        dashboard: snapshot([
          attention("one"),
          attention("one"),
          attention("two"),
          attention("review", "review"),
          attention("test", "test"),
          attention("question", "question"),
        ]),
      }).openDecisionCount,
    ).toBe(6);
    expect(
      selectChiefOfStaffSummary({ thread: desk, projection: null, dashboard: snapshot([]) })
        .openDecisionCount,
    ).toBe(0);
  });
  it("keeps the last assistant reply when a newer user message is the shell preview", () => {
    const thread = {
      ...desk,
      latestVisibleMessage: {
        id: MessageId.make("user"),
        role: "user" as const,
        text: "Next?",
        updatedAt: userAt,
      },
    };
    expect(selectChiefOfStaffSummary({ thread, projection, dashboard: null }).lastReplyAt).toBe(
      "2026-10-12T04:30:00.000Z",
    );
    expect(
      selectChiefOfStaffSummary({ thread, projection: null, dashboard: null }).lastReplyAt,
    ).toBeNull();
    expect(
      selectChiefOfStaffSummary({
        thread: desk,
        projection: { ...projection, thread: { ...projection.thread, id: operations.id } },
        dashboard: null,
      }).lastReplyAt,
    ).toBeNull();
  });
  it("uses a newer assistant shell preview and ignores inherited or empty replies", () => {
    const thread = {
      ...desk,
      latestVisibleMessage: {
        id: MessageId.make("new"),
        role: "assistant" as const,
        text: "New reply",
        updatedAt: userAt,
      },
    };
    expect(selectChiefOfStaffSummary({ thread, projection, dashboard: null }).lastReplyAt).toBe(
      "2026-10-12T04:40:00.000Z",
    );
    const unrelated = {
      ...projection,
      messages: [
        { ...projection.messages[0]!, threadId: operations.id, updatedAt: userAt },
        { ...projection.messages[0]!, text: " " },
      ],
    };
    expect(
      selectChiefOfStaffSummary({ thread: desk, projection: unrelated, dashboard: null })
        .lastReplyAt,
    ).toBeNull();
    expect(
      selectChiefOfStaffSummary({
        thread: { ...desk, status: "queued", activityRunStatus: "running" },
        projection: null,
        dashboard: null,
      }).isBusy,
    ).toBe(true);
  });
  it("uses the newest assistant message regardless of message order", () => {
    const messages = [
      { ...projection.messages[0]!, id: MessageId.make("new-reply"), updatedAt: userAt },
      projection.messages[0]!,
      {
        ...projection.messages[0]!,
        id: MessageId.make("later-user"),
        role: "user" as const,
        updatedAt: DateTime.makeUnsafe("2026-10-12T05:00:00Z"),
      },
    ];
    expect(
      selectChiefOfStaffSummary({
        thread: desk,
        projection: { ...projection, messages },
        dashboard: null,
      }).lastReplyAt,
    ).toBe("2026-10-12T04:40:00.000Z");
  });
  it.each(["Front Desk", "chief-of-staff", " Chief of Staff "])(
    "discovers the exact title %s",
    (title) => {
      const thread = { ...desk, title };
      expect(selectChiefOfStaffThread([operations, thread], null)).toBe(thread);
    },
  );
  it.each(["preparing", "queued", "starting", "running", "waiting"] as const)(
    "reports %s as busy",
    (status) => {
      expect(
        selectChiefOfStaffSummary({
          thread: { ...desk, status },
          projection: null,
          dashboard: null,
        }).isBusy,
      ).toBe(true);
    },
  );
  it.each(["idle", "completed", "failed", "interrupted"] as const)(
    "reports %s as quiet",
    (status) => {
      expect(
        selectChiefOfStaffSummary({
          thread: { ...desk, status },
          projection: null,
          dashboard: null,
        }).isBusy,
      ).toBe(false);
    },
  );
  it("resolves titles in the primary environment and preferences in their own environment", () => {
    const primary = EnvironmentId.make("primary");
    const remote = EnvironmentId.make("remote");
    const threads = [
      { ...desk, environmentId: remote },
      { ...operations, environmentId: primary },
    ];
    expect(
      selectScopedChiefOfStaffThread({ threads, preferred: null, primaryEnvironmentId: primary }),
    ).toBeNull();
    expect(
      selectScopedChiefOfStaffThread({
        threads,
        preferred: { environmentId: remote, threadId: desk.id },
        primaryEnvironmentId: primary,
      }),
    ).toEqual({ environmentId: remote, threadId: desk.id });
  });
  it.each(["running", "failed", "interrupted"] as const)(
    "does not count a %s run with no assistant message as a reply",
    (status) => {
      const thread = {
        ...desk,
        status,
        latestRunCompletedAt: userAt,
        latestVisibleMessage: {
          id: MessageId.make("user"),
          role: "user" as const,
          text: "Next?",
          updatedAt: userAt,
        },
      };
      expect(selectChiefOfStaffSummary({ thread, projection, dashboard: null }).lastReplyAt).toBe(
        "2026-10-12T04:30:00.000Z",
      );
      expect(
        selectChiefOfStaffSummary({ thread, projection: null, dashboard: null }).lastReplyAt,
      ).toBeNull();
    },
  );
});
