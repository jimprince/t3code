/**
 * Who sent a user-role message when it was not the person at the keyboard.
 *
 * Worker notifications and `t3-thread send` arrive as ordinary user messages, so
 * the sender rides along as one unreferenced context record. Records that the
 * message text does not reference never reach the provider or render as chips,
 * and clients that predate this kind keep it as an unknown record. Messages from
 * older CLIs carry no record; the notification text prefix is the fallback.
 */
import type { ComposerContextId, OrchestrationMessageContext } from "@t3tools/contracts";

const MESSAGE_ORIGIN_CONTEXT_KIND = "t3-origin";

export type MessageOriginSource = "worker-notification" | "thread-send";

export interface MessageOrigin {
  readonly source: MessageOriginSource;
  /** Thread that produced the message: the notifying worker, or the sending thread. */
  readonly fromThreadId?: string;
  /** Saved agent name of that thread, when the sender knew it. */
  readonly fromName?: string;
}

const NOTIFICATION_PREFIX = /^(?:HomeNetwork|T3) orchestrator notification: (\S+) /;

/** Context to attach to a `message.dispatch` message sent on someone's behalf. */
export function makeMessageOriginContext(origin: MessageOrigin): OrchestrationMessageContext {
  return {
    version: 1,
    records: [
      {
        version: 1,
        // The fixed id satisfies the ComposerContextId pattern; a type-only import keeps
        // the CLI bundle from loading the contracts runtime.
        contextId: MESSAGE_ORIGIN_CONTEXT_KIND as ComposerContextId,
        label: "",
        kind: MESSAGE_ORIGIN_CONTEXT_KIND,
        payload: origin,
      },
    ],
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function decodeOrigin(payload: unknown): MessageOrigin | null {
  if (!isRecord(payload)) return null;
  const { source, fromThreadId, fromName } = payload;
  if (source !== "worker-notification" && source !== "thread-send") return null;
  return {
    source,
    ...(typeof fromThreadId === "string" && fromThreadId.length > 0 ? { fromThreadId } : {}),
    ...(typeof fromName === "string" && fromName.length > 0 ? { fromName } : {}),
  };
}

/** The sender of a user message, or null when a person typed it. */
export function readMessageOrigin(message: {
  readonly text: string;
  readonly context?: { readonly records: ReadonlyArray<unknown> } | undefined;
}): MessageOrigin | null {
  for (const record of message.context?.records ?? []) {
    if (isRecord(record) && record.kind === MESSAGE_ORIGIN_CONTEXT_KIND) {
      const origin = decodeOrigin(record.payload);
      if (origin) return origin;
    }
  }
  const notification = NOTIFICATION_PREFIX.exec(message.text);
  return notification ? { source: "worker-notification", fromName: notification[1]! } : null;
}
