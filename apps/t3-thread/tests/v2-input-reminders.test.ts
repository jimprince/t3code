import { expect, it } from "vite-plus/test";
import { threadDetail } from "../src/v2/reads.js";
import {
  pendingInputKey,
  inputNotificationStillCurrent,
  withInputReminder,
} from "../src/inputReminders.js";
import { buildNotificationRecord, shouldNotify } from "../src/notifications.js";
import { buildAgentOverview } from "../src/monitor.js";
import type { SavedAgent, SavedSubscription } from "../src/types.js";
import { at, item, projection, request } from "./v2-fixture.js";
const agent: SavedAgent = {
  name: "worker",
  environment: "test",
  threadId: "worker",
  projectId: "project",
  title: "Worker",
  createdAt: at(),
  lastSeenAssistantMessageId: null,
};
const route: SavedSubscription = {
  subscriberThreadId: "parent",
  sourceThreadId: "worker",
  subscriberEnvironment: "test",
  sourceEnvironment: "test",
  subscriberAgentName: null,
  sourceAgentName: "worker",
  createdAt: at(),
  updatedAt: at(),
  level: "none",
  inputReminderMinutes: 1,
};
const pending = () => ({
  ...threadDetail(
    projection({
      runtimeRequests: [request("b"), request("a")],
      turnItems: [
        item("user_input_request", at(), {
          requestId: "a",
          questions: [
            {
              id: "q",
              header: "Question",
              question: "Choose?",
              options: [{ label: "Yes", description: "Continue" }],
            },
          ],
        }),
      ],
    }),
  ),
  parentThreadId: "parent",
});
it("uses stable native request sets and preserves required questions at every level", () => {
  const thread = pending();
  expect(pendingInputKey(thread)).toBe('["user_input:a","user_input:b"]');
  for (const level of ["none", "attention", "all"] as const)
    expect(shouldNotify({ ...route, level }, buildAgentOverview(agent, thread), thread)).toBe(true);
  const notice = buildNotificationRecord({
    sourceAgent: agent,
    subscription: route,
    overview: buildAgentOverview(agent, thread),
    thread,
    now: at(),
  });
  expect(notice.pendingQuestion).toBe("Choose? Choices: Yes");
  expect(notice.isChildInput).toBe(true);
  expect(inputNotificationStillCurrent(notice, thread)).toBe(true);
  for (const changed of [
    { ...thread, parentThreadId: "other" },
    { ...thread, archivedAt: at() },
    { ...thread, settledOverride: "settled" as const },
    { ...thread, runtimeRequests: [] },
  ])
    expect(inputNotificationStillCurrent(notice, changed)).toBe(false);
});
it("starts reminders from delivered receipts without a sleep backlog, and honors off", () => {
  const thread = pending();
  const notice = buildNotificationRecord({
    sourceAgent: agent,
    subscription: route,
    overview: buildAgentOverview(agent, thread),
    thread,
    now: at(10),
  });
  const delivered = { ...notice, status: "delivered" as const, deliveredAt: at() };
  const reminder = withInputReminder(notice, [delivered], route);
  expect(reminder.reminderOfEventKey).toBe(notice.eventKey);
  expect(
    withInputReminder(notice, [delivered], { ...route, inputReminderMinutes: 0 }).eventKey,
  ).toBe(notice.eventKey);
  expect(
    withInputReminder(
      { ...notice, updatedAt: at(10.5) },
      [delivered, { ...reminder, id: "reminder", status: "delivered", deliveredAt: at(10) }],
      route,
    ).eventKey,
  ).toBe(reminder.eventKey);
});
