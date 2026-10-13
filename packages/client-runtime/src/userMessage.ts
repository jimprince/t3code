import { type OrchestrationV2Actor, ScheduledTaskId } from "@t3tools/contracts";

const LEGACY_AUTOMATION_PREFIX = /^\[Triggered by schedule task: [^\r\n]+\]\r?\n\r?\n/;
const LEGACY_AUTOMATION_MESSAGE_ID = /^scheduled-task-message:(.+):\d+:(?:scheduled|manual)$/;

const AGENT_HEADER_PREFIX = "T3 thread message: ";
const JSON_STRING = String.raw`"(?:[^"\\]|\\.)*"`;
const HEADER_SAVED_NAME = new RegExp(`(?:^|; )saved_name: (${JSON_STRING}|null)(?:;|$)`);
const HEADER_ENVIRONMENT = new RegExp(`(?:^|; )environment: (${JSON_STRING})(?:;|$)`);

/** The sender block the `t3-thread send` CLI prepends to a message (see `senderHeader`). */
export interface AgentMessageHeader {
  /** Header line without its "T3 thread message: " prefix; carries the reply command. */
  readonly text: string;
  readonly savedName: string | null;
  readonly environment: string | null;
}

function parseJsonString(raw: string | undefined): string | null {
  if (raw === undefined || raw === "null") return null;
  try {
    const value: unknown = JSON.parse(raw);
    return typeof value === "string" ? value : null;
  } catch {
    return null;
  }
}

/**
 * Splits the CLI sender header off an agent message. Messages without the header
 * (provider or server sends) come back unchanged with `header` undefined.
 */
export function splitAgentMessageHeader(text: string): {
  readonly header: AgentMessageHeader | undefined;
  readonly text: string;
} {
  if (!text.startsWith(AGENT_HEADER_PREFIX)) return { header: undefined, text };
  const lineEnd = text.indexOf("\n");
  const line = (lineEnd === -1 ? text : text.slice(0, lineEnd)).slice(AGENT_HEADER_PREFIX.length);
  return {
    header: {
      text: line.trim(),
      savedName: parseJsonString(HEADER_SAVED_NAME.exec(line)?.[1]),
      environment: parseJsonString(HEADER_ENVIRONMENT.exec(line)?.[1]),
    },
    text: lineEnd === -1 ? "" : text.slice(lineEnd + 1),
  };
}

/**
 * Older scheduled messages stored their attribution in the prompt itself, and agent
 * messages carry the CLI sender header; both are split off the returned text.
 */
export function resolveUserMessagePresentation(message: {
  readonly id?: string;
  readonly role: string;
  readonly text: string;
  readonly createdBy?: OrchestrationV2Actor;
  readonly scheduledTaskId?: ScheduledTaskId;
}) {
  if (message.role !== "user") {
    return {
      text: message.text,
      isAutomation: false,
      scheduledTaskId: undefined,
      agentHeader: undefined,
    };
  }
  if (message.scheduledTaskId !== undefined) {
    return {
      text: message.text,
      isAutomation: true,
      scheduledTaskId: message.scheduledTaskId,
      agentHeader: undefined,
    };
  }
  const legacyPrefix = LEGACY_AUTOMATION_PREFIX.exec(message.text);
  const legacyTaskId = legacyPrefix
    ? LEGACY_AUTOMATION_MESSAGE_ID.exec(message.id ?? "")?.[1]
    : undefined;
  const isAutomation =
    legacyPrefix !== null && (legacyTaskId !== undefined || message.createdBy === "agent");
  const split =
    !isAutomation && message.createdBy === "agent"
      ? splitAgentMessageHeader(message.text)
      : { header: undefined, text: message.text };
  return {
    text: isAutomation ? message.text.slice(legacyPrefix[0].length) : split.text,
    isAutomation,
    scheduledTaskId: legacyTaskId === undefined ? undefined : ScheduledTaskId.make(legacyTaskId),
    agentHeader: split.header,
  };
}
