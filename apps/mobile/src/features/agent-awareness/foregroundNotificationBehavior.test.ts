import { notificationEventKey } from "@t3tools/client-runtime/notification-eligibility";
import type { Notification } from "expo-notifications";
import { describe, expect, it } from "vite-plus/test";

import { foregroundNotificationBehavior } from "./foregroundNotificationBehavior";
import { threadDeepLinkOnScreen } from "./notificationPayload";

function notificationWithData(data: Record<string, unknown>): Notification {
  return {
    date: 0,
    request: {
      identifier: "notification-1",
      content: {
        data: {
          environmentId: "env-1",
          threadId: "thread-1",
          notification: {
            kind: "reply",
            identity: "turn",
            origin: "human",
            occurredAt: new Date().toISOString(),
          },
          ...data,
        },
      },
      trigger: null,
    },
  } as unknown as Notification;
}

describe("threadDeepLinkOnScreen", () => {
  it("maps a thread route and its nested screens to the thread deep link", () => {
    expect(threadDeepLinkOnScreen("/threads/env-1/thread-1")).toBe("/threads/env-1/thread-1");
    expect(threadDeepLinkOnScreen("/threads/env-1/thread-1/files/src")).toBe(
      "/threads/env-1/thread-1",
    );
  });

  it("returns null outside a thread", () => {
    expect(threadDeepLinkOnScreen("/")).toBeNull();
    expect(threadDeepLinkOnScreen("/settings")).toBeNull();
    expect(threadDeepLinkOnScreen("/threads/env-1")).toBeNull();
  });
});

describe("foregroundNotificationBehavior", () => {
  it("suppresses a notification for the thread already on screen", () => {
    const behavior = foregroundNotificationBehavior(
      notificationWithData({ environmentId: "env-1", threadId: "thread-1" }),
      "/threads/env-1/thread-1",
    );
    expect(behavior.shouldShowBanner).toBe(false);
    expect(behavior.shouldShowList).toBe(false);
    expect(behavior.shouldPlaySound).toBe(false);
  });

  it("shows a notification for another thread", () => {
    const behavior = foregroundNotificationBehavior(
      notificationWithData({ deepLink: "/threads/env-1/thread-2" }),
      "/threads/env-1/thread-1",
    );
    expect(behavior.shouldShowBanner).toBe(true);
    expect(behavior.shouldShowList).toBe(true);
  });

  it("shows a notification when no thread is open or the payload has no target", () => {
    expect(
      foregroundNotificationBehavior(
        notificationWithData({ environmentId: "env-1", threadId: "thread-1" }),
        null,
      ).shouldShowBanner,
    ).toBe(true);
    expect(
      foregroundNotificationBehavior(
        notificationWithData({
          environmentId: undefined,
          threadId: undefined,
          notification: undefined,
        }),
        "/threads/env-1/thread-1",
      ).shouldShowBanner,
    ).toBe(true);
  });
});

it.each(["worker", "routed", "automation", "unknown"])(
  "suppresses a %s reply locally",
  (origin) => {
    const notification = notificationWithData({
      environmentId: "env-1",
      threadId: "thread-1",
      notification: {
        kind: "reply",
        identity: "turn",
        origin,
        occurredAt: new Date().toISOString(),
      },
    });
    expect(foregroundNotificationBehavior(notification, null).shouldPlaySound).toBe(false);
  },
);

it("keeps worker questions and decisions useful and deduplicates a scoped request", () => {
  for (const kind of ["question", "approval", "decision", "error", "attention"] as const) {
    const event = {
      kind,
      identity: "request-one",
      origin: "worker" as const,
      occurredAt: new Date().toISOString(),
    };
    const notification = notificationWithData({ notification: event });
    expect(foregroundNotificationBehavior(notification, null).shouldPlaySound).toBe(true);
    expect(
      foregroundNotificationBehavior(
        notification,
        null,
        new Set([notificationEventKey("env-1", "thread-1", event)]),
      ).shouldShowBanner,
    ).toBe(false);
    expect(
      foregroundNotificationBehavior(
        notificationWithData({ notification: { ...event, identity: "request-two" } }),
        null,
        new Set([notificationEventKey("env-1", "thread-1", event)]),
      ).shouldShowBanner,
    ).toBe(true);
  }
});
it("silences stale replies and agent payloads missing provenance", () => {
  expect(
    foregroundNotificationBehavior(notificationWithData({ notification: undefined }), null)
      .shouldShowBanner,
  ).toBe(false);
  expect(
    foregroundNotificationBehavior(
      notificationWithData({
        notification: {
          kind: "reply",
          identity: "old",
          origin: "human",
          occurredAt: "2000-01-01T00:00:00Z",
        },
      }),
      null,
    ).shouldPlaySound,
  ).toBe(false);
});
