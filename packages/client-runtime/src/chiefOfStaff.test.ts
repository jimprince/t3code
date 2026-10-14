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

describe("selectScopedChiefOfStaffThread across environments", () => {
  const mac = EnvironmentId.make("mac");
  const devVm = EnvironmentId.make("dev-vm");
  const shell = (
    environmentId: EnvironmentId,
    id: string,
    title: string,
    overrides: {
      archivedAt?: string | null;
      updatedAt?: string;
      pinnedAt?: string | null;
      runtime?: { status: string } | null;
    } = {},
  ) => ({
    environmentId,
    id: ThreadId.make(id),
    title,
    archivedAt: null as string | null,
    updatedAt: "2026-10-12T00:00:00Z",
    ...overrides,
  });
  const ref = (environmentId: EnvironmentId, id: string) => ({
    environmentId,
    threadId: ThreadId.make(id),
  });
  // Brad's real shape: the Mac has no desk thread; the dev-vm has the desk and its inbox.
  const macThread = shell(mac, "mac-other", "Some project");
  const deskOnVm = shell(devVm, "e942f826", "Chief of Staff");
  const inboxOnVm = shell(devVm, "82b73eb7", "Chief of Staff inbox");

  it("finds the desk on a non-primary environment with no preference anywhere", () => {
    expect(
      selectScopedChiefOfStaffThread({
        threads: [macThread, inboxOnVm, deskOnVm],
        preferred: [],
        primaryEnvironmentId: mac,
      }),
    ).toEqual(ref(devVm, "e942f826"));
  });
  it("never matches the inbox by title", () => {
    expect(
      selectScopedChiefOfStaffThread({
        threads: [macThread, inboxOnVm],
        preferred: [],
        primaryEnvironmentId: mac,
      }),
    ).toBeNull();
  });
  it("lets a stale preference fall through to the next environment's preference", () => {
    const real = shell(devVm, "real", "Whatever");
    expect(
      selectScopedChiefOfStaffThread({
        threads: [macThread, real],
        preferred: [ref(mac, "deleted"), ref(devVm, "real")],
        primaryEnvironmentId: mac,
      }),
    ).toEqual(ref(devVm, "real"));
  });
  it("falls back to the title match when the only preference is stale", () => {
    expect(
      selectScopedChiefOfStaffThread({
        threads: [macThread, deskOnVm],
        preferred: [ref(mac, "deleted")],
        primaryEnvironmentId: mac,
      }),
    ).toEqual(ref(devVm, "e942f826"));
  });
  it("keeps an existing explicit preference over a title match", () => {
    const chosen = shell(devVm, "chosen", "Anything");
    expect(
      selectScopedChiefOfStaffThread({
        threads: [shell(mac, "mac-desk", "Chief of Staff"), chosen],
        preferred: [ref(devVm, "chosen")],
        primaryEnvironmentId: mac,
      }),
    ).toEqual(ref(devVm, "chosen"));
  });
  it("skips an archived desk", () => {
    expect(
      selectScopedChiefOfStaffThread({
        threads: [macThread, { ...deskOnVm, archivedAt: "2026-10-01T00:00:00Z" }],
        preferred: [],
        primaryEnvironmentId: mac,
      }),
    ).toBeNull();
  });
  describe("three threads titled Chief of Staff on the dev-vm", () => {
    // Real shapes: the live desk replaced a failed, still pinned one and a failed empty one.
    const pinned = "2026-10-10T00:00:00Z";
    const live = (overrides: Parameters<typeof shell>[3] = {}) =>
      shell(devVm, "2bf407ef-9db0-4b3f-bc7d-584d655c26a9", "Chief of Staff", {
        runtime: { status: "running" },
        updatedAt: "2026-10-13T20:00:00Z",
        ...overrides,
      });
    const oldFailed = shell(devVm, "e942f826", "Chief of Staff", {
      runtime: { status: "failed" },
      pinnedAt: pinned,
      updatedAt: "2026-10-13T22:00:00Z",
    });
    const emptyFailed = shell(devVm, "f61fa895", "Chief of Staff", {
      runtime: { status: "failed" },
      updatedAt: "2026-10-13T23:00:00Z",
    });
    const pick = (threads: ReturnType<typeof shell>[]) =>
      selectScopedChiefOfStaffThread({ threads, preferred: [], primaryEnvironmentId: mac });
    const liveRef = ref(devVm, "2bf407ef-9db0-4b3f-bc7d-584d655c26a9");

    it.each([
      ["pinned", live({ pinnedAt: pinned })],
      ["unpinned, with an older pinned failed desk", live()],
      ["idle", live({ runtime: { status: "idle" } })],
      ["with no runtime yet", live({ runtime: null })],
    ])("picks the live desk (%s)", (_name, desk) => {
      expect(pick([oldFailed, emptyFailed, desk, inboxOnVm])).toEqual(liveRef);
      expect(pick([desk, inboxOnVm, emptyFailed, oldFailed])).toEqual(liveRef);
    });
    it("prefers pinned among healthy desks, then recency, then id", () => {
      const healthy = (id: string, overrides: Parameters<typeof shell>[3]) =>
        shell(devVm, id, "Chief of Staff", { runtime: { status: "idle" }, ...overrides });
      const old = healthy("a", { pinnedAt: pinned, updatedAt: "2026-10-01T00:00:00Z" });
      const fresh = healthy("b", { updatedAt: "2026-10-05T00:00:00Z" });
      expect(pick([fresh, old])).toEqual(ref(devVm, "a"));
      const x = healthy("x", { updatedAt: "2026-10-05T00:00:00Z" });
      const y = healthy("y", { updatedAt: "2026-10-05T00:00:00Z" });
      expect(pick([x, y])).toEqual(ref(devVm, "y"));
      expect(pick([y, x])).toEqual(ref(devVm, "y"));
    });
    it("still returns a failed desk when it is the only one, and an explicit preference wins", () => {
      expect(pick([oldFailed, inboxOnVm])).toEqual(ref(devVm, "e942f826"));
      expect(
        selectScopedChiefOfStaffThread({
          threads: [oldFailed, live(), inboxOnVm],
          preferred: [ref(devVm, "e942f826")],
          primaryEnvironmentId: mac,
        }),
      ).toEqual(ref(devVm, "e942f826"));
    });
  });
  it("prefers the primary environment, then the most recently updated, among several matches", () => {
    const macDesk = shell(mac, "mac-desk", "Front Desk", { updatedAt: "2026-10-01T00:00:00Z" });
    const older = shell(devVm, "older", "Chief of Staff", {
      updatedAt: "2026-10-02T00:00:00Z",
    });
    const newer = shell(devVm, "newer", "Chief of Staff", {
      updatedAt: "2026-10-03T00:00:00Z",
    });
    expect(
      selectScopedChiefOfStaffThread({
        threads: [older, macDesk, newer],
        preferred: [],
        primaryEnvironmentId: mac,
      }),
    ).toEqual(ref(mac, "mac-desk"));
    expect(
      selectScopedChiefOfStaffThread({
        threads: [older, newer],
        preferred: [],
        primaryEnvironmentId: mac,
      }),
    ).toEqual(ref(devVm, "newer"));
  });
});

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
