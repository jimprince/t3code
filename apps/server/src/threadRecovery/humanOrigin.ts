import type { OrchestrationV2ConversationMessage } from "@t3tools/contracts";

/** Keep operator history reads aligned with pending-human recovery. */
export function isHumanAuthoredMessage(
  message: Pick<
    OrchestrationV2ConversationMessage,
    "role" | "scheduledTaskId" | "senderThreadId" | "humanOrigin" | "createdBy" | "creationSource"
  >,
): boolean {
  return (
    message.role === "user" &&
    message.scheduledTaskId === undefined &&
    message.senderThreadId === undefined &&
    (message.humanOrigin !== undefined ||
      (message.createdBy === "user" &&
        (message.creationSource === "web" || message.creationSource === "mobile")))
  );
}
