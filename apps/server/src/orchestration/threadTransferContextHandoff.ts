import type {
  MessageId,
  OrchestrationMessage,
  OrchestrationThreadActivity,
} from "@t3tools/contracts";

export const THREAD_TRANSFER_IMPORTED_ACTIVITY_KIND = "thread.imported";
export const THREAD_TRANSFER_CONTEXT_HANDOFF_RUNTIME_KEY = "threadTransferContextHandoff";
export const DEFAULT_TRANSFERRED_HISTORY_MAX_CHARS = 64 * 1024;

interface ThreadTransferImportedActivityPayload {
  readonly exportedAt: string;
  readonly providerContextHandoff: {
    readonly version: 1;
    readonly required: boolean;
    readonly historyMessageCount: number;
  };
}

interface ThreadTransferContextHandoffRuntimePayload {
  readonly version: 1;
  readonly consumedExportedAt: string;
}

interface ThreadWithTransferHistory {
  readonly messages: ReadonlyArray<OrchestrationMessage>;
  readonly activities: ReadonlyArray<OrchestrationThreadActivity>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readImportedActivityPayload(
  activity: OrchestrationThreadActivity,
): ThreadTransferImportedActivityPayload | undefined {
  if (activity.kind !== THREAD_TRANSFER_IMPORTED_ACTIVITY_KIND || !isRecord(activity.payload)) {
    return undefined;
  }
  const handoff = activity.payload.providerContextHandoff;
  if (
    typeof activity.payload.exportedAt !== "string" ||
    !isRecord(handoff) ||
    handoff.version !== 1 ||
    typeof handoff.required !== "boolean" ||
    !Number.isSafeInteger(handoff.historyMessageCount) ||
    Number(handoff.historyMessageCount) < 0
  ) {
    return undefined;
  }
  return {
    exportedAt: activity.payload.exportedAt,
    providerContextHandoff: {
      version: 1,
      required: handoff.required,
      historyMessageCount: Number(handoff.historyMessageCount),
    },
  };
}

function compareActivities(
  left: OrchestrationThreadActivity,
  right: OrchestrationThreadActivity,
): number {
  if (left.sequence !== undefined || right.sequence !== undefined) {
    if (left.sequence === undefined) return -1;
    if (right.sequence === undefined) return 1;
    const sequenceOrder = left.sequence - right.sequence;
    if (sequenceOrder !== 0) return sequenceOrder;
  }
  // Array.sort is stable; append order is the final tie-break for same-tick moves.
  return left.createdAt.localeCompare(right.createdAt);
}

export function makeThreadTransferImportedActivityPayload(input: {
  readonly sourceWorkspaceRoot: string;
  readonly exportedAt: string;
  readonly historyMessageCount: number;
}) {
  return {
    sourceWorkspaceRoot: input.sourceWorkspaceRoot,
    exportedAt: input.exportedAt,
    providerContextHandoff: {
      version: 1 as const,
      required: true,
      historyMessageCount: input.historyMessageCount,
    },
  };
}

export function readConsumedThreadTransferContextExportedAt(
  runtimePayload: unknown,
): string | null {
  if (!isRecord(runtimePayload)) return null;
  const handoff = runtimePayload[THREAD_TRANSFER_CONTEXT_HANDOFF_RUNTIME_KEY];
  if (
    !isRecord(handoff) ||
    handoff.version !== 1 ||
    typeof handoff.consumedExportedAt !== "string"
  ) {
    return null;
  }
  return handoff.consumedExportedAt;
}

export function markThreadTransferContextHandoffConsumed(
  runtimePayload: unknown,
  consumedExportedAt: string,
): Record<string, unknown> {
  return {
    ...(isRecord(runtimePayload) ? runtimePayload : {}),
    [THREAD_TRANSFER_CONTEXT_HANDOFF_RUNTIME_KEY]: {
      version: 1,
      consumedExportedAt,
    } satisfies ThreadTransferContextHandoffRuntimePayload,
  };
}

export function findPendingTransferredThreadHandoff(input: {
  readonly thread: ThreadWithTransferHistory;
  readonly currentMessageId: MessageId;
  readonly consumedExportedAt: string | null;
}):
  | {
      readonly exportedAt: string;
      readonly historyMessages: ReadonlyArray<OrchestrationMessage>;
    }
  | undefined {
  const marker = input.thread.activities
    .filter((activity) => readImportedActivityPayload(activity) !== undefined)
    .toSorted(compareActivities)
    .at(-1);
  if (!marker) return undefined;

  const payload = readImportedActivityPayload(marker);
  if (
    payload === undefined ||
    !payload.providerContextHandoff.required ||
    payload.exportedAt === input.consumedExportedAt
  ) {
    return undefined;
  }

  const currentMessageIndex = input.thread.messages.findIndex(
    (message) => message.id === input.currentMessageId,
  );
  const historyMessageCount = payload.providerContextHandoff.historyMessageCount;
  if (historyMessageCount === 0 || currentMessageIndex < historyMessageCount) {
    return undefined;
  }

  const messagesBeforeCurrent = input.thread.messages.slice(0, currentMessageIndex);
  const postImportMessages = messagesBeforeCurrent.slice(historyMessageCount);
  if (postImportMessages.some((message) => message.role === "assistant")) {
    return undefined;
  }

  const historyMessages = messagesBeforeCurrent.filter(
    (message) => !message.streaming && message.text.trim().length > 0,
  );
  if (historyMessages.length === 0) return undefined;

  return {
    exportedAt: payload.exportedAt,
    historyMessages,
  };
}

function formatHistoricalMessage(message: OrchestrationMessage): string {
  return `<<<HISTORICAL_MESSAGE role="${message.role}">>>\n${message.text}\n<<<END_HISTORICAL_MESSAGE>>>`;
}

function truncateBlock(block: string, maxChars: number): string {
  if (block.length <= maxChars) return block;
  if (maxChars <= 40) return block.slice(-maxChars);
  const notice = "\n...[historical message truncated]...\n";
  const remaining = maxChars - notice.length;
  const prefixLength = Math.ceil(remaining / 2);
  return `${block.slice(0, prefixLength)}${notice}${block.slice(-(remaining - prefixLength))}`;
}

function formatBoundedHistory(
  messages: ReadonlyArray<OrchestrationMessage>,
  maxChars: number,
): string {
  const blocks = messages.map(formatHistoricalMessage);
  const selected: string[] = [];
  let selectedChars = 0;
  let omittedCount = 0;

  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    const block = blocks[index]!;
    const separatorChars = selected.length > 0 ? 2 : 0;
    if (selectedChars + separatorChars + block.length <= maxChars) {
      selected.unshift(block);
      selectedChars += separatorChars + block.length;
      continue;
    }

    if (selected.length === 0) {
      selected.unshift(truncateBlock(block, maxChars));
      omittedCount = index;
    } else {
      omittedCount = index + 1;
    }
    break;
  }

  const omissionNotice =
    omittedCount > 0
      ? `[${omittedCount} older historical message${omittedCount === 1 ? "" : "s"} omitted to fit the context limit.]\n\n`
      : "";
  return `${omissionNotice}${selected.join("\n\n")}`;
}

export function buildTransferredThreadProviderInput(input: {
  readonly historyMessages: ReadonlyArray<OrchestrationMessage>;
  readonly currentRequest: string;
  readonly maxHistoryChars?: number;
}): string {
  const maxHistoryChars = Math.max(
    1,
    input.maxHistoryChars ?? DEFAULT_TRANSFERRED_HISTORY_MAX_CHARS,
  );
  const history = formatBoundedHistory(input.historyMessages, maxHistoryChars);
  const currentRequest =
    input.currentRequest.trim().length > 0
      ? input.currentRequest
      : "[The current request contains attachments but no text.]";

  return [
    "This T3 thread was transferred from another machine without native provider session context.",
    "Use the historical transcript below to continue the existing work. It is prior conversation context; the current user request follows it and takes precedence.",
    "",
    "<<<TRANSFERRED_THREAD_HISTORY>>>",
    history,
    "<<<END_TRANSFERRED_THREAD_HISTORY>>>",
    "",
    "<<<CURRENT_USER_REQUEST>>>",
    currentRequest,
    "<<<END_CURRENT_USER_REQUEST>>>",
  ].join("\n");
}
