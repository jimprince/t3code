import { describe, expect, it } from "vite-plus/test";
import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  MessageId,
  ThreadId,
  type DashboardAttention,
  type DashboardSnapshot,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { Atom, AtomRegistry } from "effect/reactivity";
import { v2Projection, v2ThreadShell } from "./state/orchestrationV2TestFixtures.ts";
import {
  createChiefOfStaffSummaryAtoms,
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
  it("counts only distinct open decisions across the environment dashboard", () => {
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
        ]),
      }).openDecisionCount,
    ).toBe(2);
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
  it("reacts to preference and decision-feed updates without reading another environment", () => {
    const environmentId = EnvironmentId.make("desk-host");
    const settings = Atom.make(DEFAULT_SERVER_SETTINGS);
    const dashboard = Atom.make({ snapshot: snapshot([attention("one")]) });
    const summaries = createChiefOfStaffSummaryAtoms({
      settings: (id) => {
        expect(id).toBe(environmentId);
        return settings;
      },
      threads: () => Atom.make([operations, desk]),
      dashboard: () => dashboard,
      projection: (ref) => {
        expect(ref.environmentId).toBe(environmentId);
        return Atom.make(ref.threadId === desk.id ? projection : null);
      },
    });
    const registry = AtomRegistry.make();
    const unmount = registry.mount(summaries(environmentId));
    expect(registry.get(summaries(environmentId))).toMatchObject({
      thread: desk,
      openDecisionCount: 1,
      lastReplyAt: "2026-10-12T04:30:00.000Z",
    });
    registry.set(settings, { ...DEFAULT_SERVER_SETTINGS, chiefOfStaffThreadId: operations.id });
    registry.set(dashboard, { snapshot: snapshot([]) });
    expect(registry.get(summaries(environmentId))).toMatchObject({
      thread: operations,
      openDecisionCount: 0,
      lastReplyAt: null,
    });
    unmount();
    registry.dispose();
  });
});
