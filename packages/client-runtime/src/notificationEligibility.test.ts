import * as DateTime from "effect/DateTime";
import { expect, it } from "vite-plus/test";
import type { ThreadNotificationEvent } from "@t3tools/contracts";
import {
  evaluateNotification,
  notificationEventKey,
  threadNotificationEvent,
  threadNotificationBusy,
  notificationMessage,
  notificationDispositionForReply,
  notificationOriginForMessage,
  groupedNotificationTitle,
} from "./notificationEligibility.ts";
const event: ThreadNotificationEvent = {
  kind: "reply",
  identity: "turn",
  origin: "human",
  occurredAt: "2026-10-06T20:00:00Z",
};
const input = {
  event,
  environmentId: "env",
  threadId: "thread",
  nowMs: Date.parse(event.occurredAt),
};
it("allows a human reply once per scoped turn", () => {
  expect(evaluateNotification(input).eligible).toBe(true);
  const seen = new Set([notificationEventKey("env", "thread", event)]);
  expect(evaluateNotification({ ...input, seen }).eligible).toBe(false);
  expect(evaluateNotification({ ...input, environmentId: "other", seen }).eligible).toBe(true);
  expect(
    evaluateNotification({ ...input, event: { ...event, identity: "other-turn" }, seen }).eligible,
  ).toBe(true);
});
it.each(["worker", "routed", "automation", "unknown"] as const)("silences %s replies", (origin) => {
  expect(evaluateNotification({ ...input, event: { ...event, origin } }).eligible).toBe(false);
});
it.each(["question", "approval", "decision", "error", "attention"] as const)(
  "preserves actionable %s regardless of turn origin",
  (kind) => {
    expect(
      evaluateNotification({ ...input, event: { ...event, kind, origin: "worker" } }).eligible,
    ).toBe(true);
  },
);
it.each(["onScreen", "archived", "superseded", "busy", "quiet"] as const)(
  "silences %s reply",
  (flag) => {
    expect(evaluateNotification({ ...input, [flag]: true }).eligible).toBe(false);
  },
);
it("rejects stale and invalid terminal timestamps without aging out pending questions", () => {
  expect(evaluateNotification({ ...input, nowMs: input.nowMs + 120_001 }).eligible).toBe(false);
  expect(
    evaluateNotification({ ...input, event: { ...event, occurredAt: "invalid" } }).eligible,
  ).toBe(false);
  expect(
    evaluateNotification({
      ...input,
      event: { ...event, kind: "question" },
      nowMs: input.nowMs + 3600_000,
    }).eligible,
  ).toBe(true);
});
it("alerts for an observed failure however late the client saw it, but not for a replayed one", () => {
  const error = { ...event, kind: "error" as const, errorReason: "Agent failed" };
  const late = { ...input, event: error, nowMs: input.nowMs + 3600_000 };
  expect(evaluateNotification({ ...late, observed: true }).eligible).toBe(true);
  expect(evaluateNotification(late).eligible).toBe(false);
  // Only failures are exempt: an observed reply that is hours old stays stale.
  expect(
    evaluateNotification({ ...input, nowMs: input.nowMs + 3600_000, observed: true }).eligible,
  ).toBe(false);
});
it("new requests in the same turn have separate identities", () => {
  const question = { ...event, kind: "question" as const, identity: "request-one" };
  const seen = new Set([notificationEventKey("env", "thread", question)]);
  expect(evaluateNotification({ ...input, event: question, seen }).eligible).toBe(false);
  expect(
    evaluateNotification({ ...input, event: { ...question, identity: "request-two" }, seen })
      .eligible,
  ).toBe(true);
});

it.each(["web", "mobile"])("reads human origin from %s starting message", (creationSource) => {
  expect(notificationOriginForMessage({ createdBy: "user", creationSource })).toBe("human");
});
it.each([
  [{ createdBy: "agent", creationSource: "mcp" }, "worker"],
  [{ createdBy: "user", creationSource: "web", senderThreadId: "worker" }, "worker"],
  [{ createdBy: "user", creationSource: "web", scheduledTaskId: "job" }, "automation"],
  [{ createdBy: "user", creationSource: "web", notification: {} }, "routed"],
  [{ createdBy: "user", creationSource: "server" }, "unknown"],
  [null, "unknown"],
] as const)("filters starting message provenance %j", (message, origin) => {
  expect(notificationOriginForMessage(message)).toBe(origin);
});
it("approved grouped copy counts replies and mixed actionable items", () => {
  expect(groupedNotificationTitle([event, event])).toBe("2 replies ready");
  expect(groupedNotificationTitle([event, { ...event, kind: "question" }])).toBe("2 need you");
});
it("same-thread work blocks replies but descendants do not", () => {
  expect(
    threadNotificationBusy({ activeRunId: null, activityRunStatus: null, status: "completed" }),
  ).toBe(false);
  expect(
    threadNotificationBusy({
      activeRunId: null,
      activityRunStatus: "running",
      status: "completed",
    }),
  ).toBe(true);
  expect(notificationMessage({ ...event, kind: "question" })).toBe("Question for you");
});

it("only a final nonstreaming disposition marker changes attention", () => {
  expect(notificationDispositionForReply("Done\nT3_NOTIFY: quiet\n")).toBe("quiet");
  expect(notificationDispositionForReply("T3_NOTIFY: quiet\nMore work")).toBeNull();
  expect(notificationDispositionForReply("Need help\nT3_NOTIFY: attention")).toBe("attention");
});

it("supersedes ended replies and errors without hiding current actionable plans", () => {
  const thread = {
    notificationOrigin: "human" as const,
    notificationSuperseded: true,
    notificationDisposition: null,
    notificationRequestId: "plan",
    latestRunId: null,
    latestRunCompletedAt: DateTime.makeUnsafe(event.occurredAt),
    pendingRuntimeRequest: null,
    hasActionableProposedPlan: false,
    status: "failed" as const,
    updatedAt: DateTime.makeUnsafe(event.occurredAt),
    lastError: "Failed",
  };
  expect(threadNotificationEvent(thread)).toBeNull();
  expect(threadNotificationEvent({ ...thread, hasActionableProposedPlan: true })?.kind).toBe(
    "decision",
  );
});

it("keeps parent-owned questions with their owner", () => {
  expect(
    evaluateNotification({
      ...input,
      event: { ...event, kind: "question", origin: "worker" },
      parentOwned: true,
    }).eligible,
  ).toBe(false);
  expect(
    evaluateNotification({
      ...input,
      event: { ...event, kind: "question", origin: "worker" },
      parentOwned: false,
    }).eligible,
  ).toBe(true);
});

it("keeps generic attention distinct from a question", () => {
  expect(notificationMessage({ ...event, kind: "question" })).toBe("Question for you");
  expect(notificationMessage({ ...event, kind: "attention" })).toBe("Input needed");
});
