import { expect, it } from "vite-plus/test";
import { withInputReminder } from "../src/inputReminders.js";
import { matchesCurrentParent } from "../src/parentRouting.js";
import type { SavedNotification } from "../src/types.js";
it("pending input follows the current local or descriptor-scoped remote parent", () => {
  expect(
    matchesCurrentParent(
      { parentThreadId: "new" },
      {
        subscriberThreadId: "old",
        subscriberEnvironment: "local",
        sourceThreadId: "child",
        sourceEnvironment: "local",
      },
    ),
  ).toBe(false);
  expect(
    matchesCurrentParent(
      { parentThreadId: "new" },
      {
        subscriberThreadId: "new",
        subscriberEnvironment: "local",
        sourceThreadId: "child",
        sourceEnvironment: "local",
      },
    ),
  ).toBe(true);
  expect(
    matchesCurrentParent(
      { remoteParent: { environmentId: "remote", threadId: "new" } },
      {
        subscriberThreadId: "new",
        subscriberEnvironmentId: "elsewhere",
        subscriberEnvironment: "paired",
        sourceThreadId: "child",
        sourceEnvironment: "local",
      },
    ),
  ).toBe(false);
  expect(
    matchesCurrentParent(
      { remoteParent: { environmentId: "remote", threadId: "new" } },
      {
        subscriberThreadId: "new",
        subscriberEnvironmentId: "remote",
        subscriberEnvironment: "paired",
        sourceThreadId: "child",
        sourceEnvironment: "local",
      },
    ),
  ).toBe(true);
});
it("creates only one durable reminder twenty minutes after confirmed delivery", () => {
  const notice: SavedNotification = {
    id: "initial",
    eventKey: "input:q",
    subscriberThreadId: "parent",
    subscriberAgentName: null,
    subscriberEnvironment: "local",
    sourceThreadId: "child",
    sourceAgentName: null,
    sourceEnvironment: "local",
    sourceState: "needs-input",
    reason: "question",
    latestAssistantMessageId: null,
    latestTurnId: "run",
    preview: null,
    status: "pending",
    createdAt: "2026-10-05T00:00:00Z",
    updatedAt: "2026-10-05T00:20:00Z",
    isChildInput: true,
  };
  const delivered = { ...notice, status: "delivered" as const, deliveredAt: notice.createdAt };
  const reminder = withInputReminder(notice, [delivered], undefined);
  expect(reminder.reminderOfEventKey).toBe(notice.eventKey);
  expect(
    withInputReminder(
      { ...notice, updatedAt: "2026-10-06T00:00:00Z" },
      [delivered, { ...reminder, status: "delivered" }],
      undefined,
    ).eventKey,
  ).toBe(reminder.eventKey);
});
