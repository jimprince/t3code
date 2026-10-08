import { notificationEventKey } from "@t3tools/client-runtime/notification-eligibility";
import { ThreadNotificationEvent } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";
import { useEffect, useLayoutEffect, useRef } from "react";
import * as Notifications from "expo-notifications";
import { useLinkTo } from "@react-navigation/native";

import { setAndroidThreadOnScreen } from "./androidNotifications";
import { foregroundNotificationBehavior } from "./foregroundNotificationBehavior";
import { routeAgentNotificationResponseOnce, threadDeepLinkOnScreen } from "./notificationPayload";
import { consumeLastAgentNotificationResponse } from "./notificationResponseConsumer";

const decodeNotificationEvent = Schema.decodeUnknownOption(ThreadNotificationEvent);

export function useAgentNotificationNavigation(pathname: string): void {
  const linkTo = useLinkTo();
  const handledResponseIds = useRef(new Set<string>());
  const seenAlerts = useRef(new Set<string>());
  // Read through a ref so the native handler registered once below sees the
  // current route without re-registering on every navigation.
  const deepLinkOnScreen = useRef<string | null>(null);
  useLayoutEffect(() => {
    const thread = threadDeepLinkOnScreen(pathname);
    deepLinkOnScreen.current = thread;
    // Android alerts are built natively from FCM data, so update the native
    // route at commit time alongside the iOS handler's route reference.
    setAndroidThreadOnScreen(thread);
  }, [pathname]);

  useEffect(() => {
    Notifications.setNotificationHandler({
      handleNotification: (notification) => {
        const behavior = foregroundNotificationBehavior(
          notification,
          deepLinkOnScreen.current,
          seenAlerts.current,
        );
        const data = notification.request.content.data ?? {};
        const event = Option.getOrNull(decodeNotificationEvent(data.notification));
        if (event)
          seenAlerts.current.add(
            notificationEventKey(
              String(data.environmentId ?? ""),
              String(data.threadId ?? ""),
              event,
            ),
          );
        while (seenAlerts.current.size > 512)
          seenAlerts.current.delete(seenAlerts.current.values().next().value!);
        return Promise.resolve(behavior);
      },
    });
    return () => {
      Notifications.setNotificationHandler(null);
    };
  }, []);

  useEffect(() => {
    const handleResponse = (response: Notifications.NotificationResponse): void => {
      routeAgentNotificationResponseOnce({
        handledResponseIds: handledResponseIds.current,
        response,
        navigate: linkTo,
      });
    };

    const subscription = Notifications.addNotificationResponseReceivedListener(handleResponse);
    void consumeLastAgentNotificationResponse({
      getLastResponse: () => Notifications.getLastNotificationResponseAsync(),
      clearLastResponse: () => Notifications.clearLastNotificationResponseAsync(),
      handleResponse,
    });

    return () => {
      subscription.remove();
    };
  }, [linkTo]);
}
