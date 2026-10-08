import { evaluateNotification } from "@t3tools/client-runtime/notification-eligibility";
import { ThreadNotificationEvent } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";
import type { Notification, NotificationBehavior } from "expo-notifications";

import { extractAgentNotificationDeepLink } from "./notificationPayload";

const decodeNotificationEvent = Schema.decodeUnknownOption(ThreadNotificationEvent);

const SHOW: NotificationBehavior = {
  shouldShowBanner: true,
  shouldShowList: true,
  shouldPlaySound: true,
  shouldSetBadge: false,
};

const SUPPRESS: NotificationBehavior = {
  shouldShowBanner: false,
  shouldShowList: false,
  shouldPlaySound: false,
  shouldSetBadge: false,
};

/**
 * Decides how a notification that arrives while the app is open is presented.
 * A notification for the thread already on screen is redundant with the live
 * feed, so it stays silent. Other agent alerts use the shared eligibility
 * rule. `deepLinkOnScreen` is the normalized `/threads/:env/:thread`
 * path of the current route, or null when no thread is open.
 */
export function foregroundNotificationBehavior(
  notification: Notification,
  deepLinkOnScreen: string | null,
  seen?: ReadonlySet<string>,
): NotificationBehavior {
  const target = extractAgentNotificationDeepLink({ notification });
  const data = notification.request.content.data ?? {};
  const event = Option.getOrNull(decodeNotificationEvent(data.notification));
  // Non-agent notifications retain their existing presentation behavior.
  if (!event && target === null) return SHOW;
  const decision = evaluateNotification({
    event,
    environmentId: String(data.environmentId ?? ""),
    threadId: String(data.threadId ?? ""),
    nowMs: Date.now(),
    onScreen: target !== null && target === deepLinkOnScreen,
    seen,
  });
  return decision.eligible ? SHOW : SUPPRESS;
}
