import { randomUUID } from "node:crypto";
import { Buffer } from "node:buffer";

import type {
  AssistantMessage,
  Event,
  Part as OpenCodePart,
  QuestionAnswer,
  Session,
  ToolPart as OpenCodeToolPart,
} from "@opencode-ai/sdk/v2/client";
import {
  type CanonicalRequestType,
  EventId,
  type ProviderApprovalDecision,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type ProviderTurnStartResult,
  type ProviderUserInputAnswers,
  RuntimeItemId,
  RuntimeRequestId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import { FileSystem, Effect, Layer, Queue, Stream } from "effect";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
} from "../Errors.ts";
import {
  buildOpenCodeDiffSummary,
  buildOpenCodePermissionRules,
  isPlanAgent,
  runtimeModeFromOpenCodePermissionRules,
  toCanonicalRequestType,
  toCanonicalToolItemType,
  toOpenCodeErrorMessage,
  toOpenCodeModel,
  toRuntimePlanStepStatus,
  toRuntimeTurnState,
} from "../opencodeEventMapping.ts";
import { OpenCodeAdapter, type OpenCodeAdapterShape } from "../Services/OpenCodeAdapter.ts";
import { OpenCodeServerPool, type OpenCodeServerLease } from "../Services/OpenCodeServerPool.ts";
import type { ProviderThreadSnapshot } from "../Services/ProviderAdapter.ts";

const PROVIDER = "opencode" as const;
const SDK_OPTIONS = {
  throwOnError: true as const,
};
const IDLE_COMPLETION_POLL_ATTEMPTS = 20;
const IDLE_COMPLETION_POLL_INTERVAL_MS = 100;
const USER_ABORT_ERROR_SUPPRESSION_WINDOW_MS = 5_000;

interface PendingPermissionRequest {
  readonly kind: "permission";
  readonly requestType: CanonicalRequestType;
  readonly turnId: TurnId | undefined;
  readonly itemId: RuntimeItemId | undefined;
}

interface PendingQuestionRequest {
  readonly kind: "question";
  readonly turnId: TurnId | undefined;
  readonly itemId: RuntimeItemId | undefined;
  readonly questions: ReadonlyArray<{
    readonly id: string;
    readonly multiple?: boolean;
    readonly custom?: boolean;
  }>;
}

interface KnownToolCall {
  readonly partId: string;
  readonly toolName: string;
}

interface OpenCodeSessionState {
  readonly threadId: ThreadId;
  readonly createdAt: string;
  readonly lease: OpenCodeServerLease;
  sessionId: string;
  cwd: string;
  poolRoot: string;
  binaryPath?: string;
  runtimeMode: ProviderSession["runtimeMode"];
  model: string | undefined;
  status: ProviderSession["status"];
  updatedAt: string;
  lastError: string | undefined;
  activeTurnId: TurnId | undefined;
  lastCompletedTurnId: TurnId | undefined;
  terminalTurnIds: Set<string>;
  knownPartKinds: Map<string, OpenCodePart["type"]>;
  knownToolStatuses: Map<string, OpenCodeToolPart["state"]["status"]>;
  knownToolsByCallId: Map<string, KnownToolCall>;
  pendingRequests: Map<string, PendingPermissionRequest | PendingQuestionRequest>;
  orderedUserMessageIds: Array<string>;
  abortErrorSuppressionUntil: number | undefined;
}

interface SidecarWatcher {
  readonly key: string;
  readonly abortController: AbortController;
  readonly task: Promise<void>;
}

function nowIso(): string {
  return new Date().toISOString();
}

function toProviderSessionSnapshot(state: OpenCodeSessionState): ProviderSession {
  return {
    provider: PROVIDER,
    status: state.status,
    runtimeMode: state.runtimeMode,
    threadId: state.threadId,
    cwd: state.cwd,
    ...(state.model ? { model: state.model } : {}),
    resumeCursor: { sessionId: state.sessionId },
    ...(state.activeTurnId ? { activeTurnId: state.activeTurnId } : {}),
    createdAt: state.createdAt,
    updatedAt: state.updatedAt,
    ...(state.lastError ? { lastError: state.lastError } : {}),
  } satisfies ProviderSession;
}

function toRequestError(method: string, detail: string, cause?: unknown) {
  return new ProviderAdapterRequestError({
    provider: PROVIDER,
    method,
    detail,
    ...(cause !== undefined ? { cause } : {}),
  });
}

function missingSession(threadId: ThreadId) {
  return new ProviderAdapterSessionNotFoundError({
    provider: PROVIDER,
    threadId,
  });
}

function toTurnIdForUserMessage(messageId: string): TurnId {
  return TurnId.makeUnsafe(`opencode:${messageId}`);
}

function userMessageIdFromTurnId(turnId: TurnId | string | undefined): string | undefined {
  if (!turnId) {
    return undefined;
  }
  const value = String(turnId);
  return value.startsWith("opencode:") ? value.slice("opencode:".length) : undefined;
}

function toToolItemId(callId: string): RuntimeItemId {
  return RuntimeItemId.makeUnsafe(`opencode-tool:${callId}`);
}

function readSessionIdFromResumeCursor(resumeCursor: unknown): string | undefined {
  if (!resumeCursor || typeof resumeCursor !== "object" || Array.isArray(resumeCursor)) {
    return undefined;
  }
  const record = resumeCursor as Record<string, unknown>;
  const sessionId = record.sessionId ?? record.sessionID;
  return typeof sessionId === "string" && sessionId.trim().length > 0 ? sessionId : undefined;
}

function toApprovalReply(decision: ProviderApprovalDecision): "once" | "always" | "reject" {
  switch (decision) {
    case "accept":
      return "once";
    case "acceptForSession":
      return "always";
    case "cancel":
    case "decline":
    default:
      return "reject";
  }
}

function toQuestionAnswers(
  pending: PendingQuestionRequest,
  answers: ProviderUserInputAnswers,
): Array<QuestionAnswer> {
  return pending.questions.map((question) => {
    const questionId = question.id;
    const value = answers[questionId];
    if (typeof value === "string") {
      return [value];
    }
    if (Array.isArray(value)) {
      return value.filter((entry): entry is string => typeof entry === "string");
    }
    return [];
  });
}

function toUserInputAnswerRecord(
  pending: PendingQuestionRequest,
  answers: ReadonlyArray<ReadonlyArray<string>>,
): Record<string, string | ReadonlyArray<string>> {
  return Object.fromEntries(
    pending.questions.map((question, index) => {
      const questionId = question.id;
      const value = answers[index] ?? [];
      if (question.multiple) {
        return [questionId, value];
      }
      return [questionId, value.length === 1 ? value[0]! : value];
    }),
  );
}

function assistantTextFromParts(parts: ReadonlyArray<OpenCodePart>): string | undefined {
  const text = parts
    .filter((part): part is Extract<OpenCodePart, { type: "text" }> => part.type === "text")
    .map((part) => part.text)
    .join("")
    .trim();
  return text.length > 0 ? text : undefined;
}

function isTerminalAssistantMessage(message: AssistantMessage): boolean {
  return (
    message.time.completed !== undefined ||
    message.finish !== undefined ||
    message.error !== undefined
  );
}

function summarizeToolDetail(part: OpenCodeToolPart): string | undefined {
  if (part.state.status === "completed") {
    const output = part.state.output.trim();
    if (output.length > 0) {
      return output;
    }
  }

  if (part.state.status === "error") {
    return part.state.error.trim() || undefined;
  }

  const command =
    part.state.input && typeof part.state.input === "object" && "command" in part.state.input
      ? part.state.input.command
      : undefined;
  if (typeof command === "string" && command.trim().length > 0) {
    return command.trim();
  }

  return part.tool;
}

function summarizePermissionDetail(patterns: ReadonlyArray<string>): string | undefined {
  if (patterns.length === 0) {
    return undefined;
  }
  return patterns.join(", ");
}

function isAbortSessionError(error: unknown): boolean {
  if (!error || typeof error !== "object" || Array.isArray(error)) {
    return false;
  }
  const record = error as { name?: unknown };
  return record.name === "MessageAbortedError";
}

function setState(state: OpenCodeSessionState, updates: Partial<OpenCodeSessionState>): void {
  Object.assign(state, updates, { updatedAt: nowIso() });
}

async function loadMessages(state: OpenCodeSessionState) {
  return state.lease.client.session
    .messages({ sessionID: state.sessionId }, SDK_OPTIONS)
    .then((result) => result.data);
}

async function loadAssistantDetail(
  state: OpenCodeSessionState,
  messageId: string,
): Promise<string | undefined> {
  const message = await state.lease.client.session.message(
    { sessionID: state.sessionId, messageID: messageId },
    SDK_OPTIONS,
  );
  return assistantTextFromParts(message.data.parts);
}

async function loadSessionHistorySummary(state: OpenCodeSessionState): Promise<{
  orderedUserMessageIds: Array<string>;
  recoveredAbortedTurnId: TurnId | undefined;
  lastCompletedTurnId: TurnId | undefined;
}> {
  const messages = await loadMessages(state);
  const orderedUserMessageIds = messages
    .filter((entry) => entry.info.role === "user")
    .map((entry) => entry.info.id);

  const latestAssistantByParentId = new Map<string, AssistantMessage>();
  for (const entry of messages) {
    if (entry.info.role === "assistant") {
      latestAssistantByParentId.set(entry.info.parentID, entry.info);
    }
  }

  const lastCompletedUserMessageId = [...orderedUserMessageIds]
    .toReversed()
    .find((messageId) => latestAssistantByParentId.get(messageId)?.time.completed !== undefined);
  const recoveredAbortedUserMessageId = [...orderedUserMessageIds]
    .toReversed()
    .find((messageId) => latestAssistantByParentId.get(messageId)?.time.completed === undefined);

  return {
    orderedUserMessageIds,
    recoveredAbortedTurnId: recoveredAbortedUserMessageId
      ? toTurnIdForUserMessage(recoveredAbortedUserMessageId)
      : undefined,
    lastCompletedTurnId: lastCompletedUserMessageId
      ? toTurnIdForUserMessage(lastCompletedUserMessageId)
      : undefined,
  };
}

async function loadTerminalAssistantForTurn(
  state: OpenCodeSessionState,
  turnId: TurnId,
): Promise<AssistantMessage | undefined> {
  const userMessageId = userMessageIdFromTurnId(turnId);
  if (!userMessageId) {
    return undefined;
  }

  const messages = await loadMessages(state);
  return messages
    .flatMap((entry) =>
      entry.info.role === "assistant" && entry.info.parentID === userMessageId ? [entry.info] : [],
    )
    .toReversed()
    .find(isTerminalAssistantMessage);
}

async function waitForTerminalAssistantForTurn(
  state: OpenCodeSessionState,
  turnId: TurnId,
): Promise<AssistantMessage | undefined> {
  for (let attempt = 0; attempt < IDLE_COMPLETION_POLL_ATTEMPTS; attempt += 1) {
    const assistant = await loadTerminalAssistantForTurn(state, turnId).catch(() => undefined);
    if (assistant) {
      return assistant;
    }
    if (attempt < IDLE_COMPLETION_POLL_ATTEMPTS - 1) {
      await new Promise((resolve) => setTimeout(resolve, IDLE_COMPLETION_POLL_INTERVAL_MS));
    }
  }
  return undefined;
}

const makeOpenCodeAdapter = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const serverConfig = yield* ServerConfig;
  const serverSettingsService = yield* ServerSettingsService;
  const pool = yield* OpenCodeServerPool;
  const services = yield* Effect.services<never>();
  const runPromise = Effect.runPromiseWith(services);
  const runtimeEventQueue = yield* Queue.unbounded<ProviderRuntimeEvent>();

  const sessions = new Map<ThreadId, OpenCodeSessionState>();
  const threadIdBySessionId = new Map<string, ThreadId>();
  const watchers = new Map<string, SidecarWatcher>();

  const publishRuntimeEvents = (events: ReadonlyArray<ProviderRuntimeEvent>) =>
    Queue.offerAll(runtimeEventQueue, events).pipe(Effect.asVoid);

  const runtimeEventBase = (input: {
    readonly threadId: ThreadId;
    readonly createdAt?: string | undefined;
    readonly turnId?: TurnId | undefined;
    readonly itemId?: RuntimeItemId | undefined;
    readonly requestId?: RuntimeRequestId | undefined;
  }) => ({
    eventId: EventId.makeUnsafe(randomUUID()),
    provider: PROVIDER,
    threadId: input.threadId,
    createdAt: input.createdAt ?? nowIso(),
    ...(input.turnId ? { turnId: input.turnId } : {}),
    ...(input.itemId ? { itemId: input.itemId } : {}),
    ...(input.requestId ? { requestId: input.requestId } : {}),
  });

  const publishAssistantCompletion = async (
    state: OpenCodeSessionState,
    assistant: AssistantMessage,
  ): Promise<void> => {
    const turnId = toTurnIdForUserMessage(assistant.parentID);
    if (state.terminalTurnIds.has(String(turnId))) {
      return;
    }

    state.terminalTurnIds.add(String(turnId));
    const assistantText = await loadAssistantDetail(state, assistant.id).catch(() => undefined);
    setState(state, {
      activeTurnId:
        state.activeTurnId && String(state.activeTurnId) === String(turnId)
          ? undefined
          : state.activeTurnId,
      abortErrorSuppressionUntil: undefined,
      lastCompletedTurnId: turnId,
      model: `${assistant.providerID}/${assistant.modelID}`,
      status: assistant.error ? "error" : "ready",
      lastError: toOpenCodeErrorMessage(assistant.error),
    });

    const createdAt = nowIso();
    const runtimeEvents: Array<ProviderRuntimeEvent> = [
      {
        ...runtimeEventBase({
          threadId: state.threadId,
          createdAt,
          turnId,
        }),
        type: "item.completed",
        payload: {
          itemType: "assistant_message",
          status: assistant.error ? "failed" : "completed",
          title: "Assistant message",
          ...(assistantText ? { detail: assistantText } : {}),
          data: assistant,
        },
      },
      {
        ...runtimeEventBase({
          threadId: state.threadId,
          createdAt,
          turnId,
        }),
        type: "turn.completed",
        payload: {
          state: toRuntimeTurnState(assistant),
          ...(assistant.finish ? { stopReason: assistant.finish } : {}),
          usage: assistant.tokens,
          modelUsage: {
            [assistant.providerID]: assistant.tokens,
          },
          totalCostUsd: assistant.cost,
          ...(toOpenCodeErrorMessage(assistant.error)
            ? { errorMessage: toOpenCodeErrorMessage(assistant.error) }
            : {}),
        },
      },
    ];

    if (assistantText && isPlanAgent(assistant.agent)) {
      runtimeEvents.push({
        ...runtimeEventBase({
          threadId: state.threadId,
          createdAt,
          turnId,
        }),
        type: "turn.proposed.completed",
        payload: {
          planMarkdown: assistantText,
        },
      });
    }

    await runPromise(publishRuntimeEvents(runtimeEvents));
  };

  const activeSessionsForKey = (key: string) =>
    Array.from(sessions.values()).filter((session) => session.lease.key === key);

  const stopWatcherIfUnused = (key: string) =>
    Effect.sync(() => {
      if (activeSessionsForKey(key).length > 0) {
        return;
      }
      const watcher = watchers.get(key);
      if (!watcher) {
        return;
      }
      watcher.abortController.abort();
      watchers.delete(key);
    });

  const getStateByThreadId = (threadId: ThreadId) => sessions.get(threadId);
  const getStateBySessionId = (sessionId: string) => {
    const threadId = threadIdBySessionId.get(sessionId);
    return threadId ? sessions.get(threadId) : undefined;
  };

  const ensureWatcher = (state: OpenCodeSessionState) =>
    Effect.sync(() => {
      if (watchers.has(state.lease.key)) {
        return;
      }

      const abortController = new AbortController();
      const task = (async () => {
        try {
          const subscription = await state.lease.client.event.subscribe(undefined, {
            ...SDK_OPTIONS,
            signal: abortController.signal,
          });

          for await (const event of subscription.stream) {
            if (abortController.signal.aborted) {
              break;
            }

            const sessionState = resolveSessionForEvent(event, getStateBySessionId);
            if (!sessionState) {
              continue;
            }

            await handleEvent(sessionState, event);
          }
        } catch {
          // The SDK SSE client retries internally; ignored here.
        } finally {
          watchers.delete(state.lease.key);
        }
      })();

      watchers.set(state.lease.key, {
        key: state.lease.key,
        abortController,
        task,
      });
    });

  const handleEvent = async (sessionState: OpenCodeSessionState, event: Event) => {
    switch (event.type) {
      case "session.status": {
        if (event.properties.status.type === "retry") {
          const createdAt = nowIso();
          setState(sessionState, { status: "running" });
          await runPromise(
            publishRuntimeEvents([
              {
                ...runtimeEventBase({
                  threadId: sessionState.threadId,
                  createdAt,
                }),
                type: "session.state.changed",
                payload: {
                  state: "waiting",
                  reason: event.properties.status.message,
                  detail: event.properties.status,
                },
              },
            ]),
          );
          break;
        }

        if (event.properties.status.type === "busy") {
          setState(sessionState, { status: "running" });
          break;
        }

        if (
          sessionState.activeTurnId &&
          !sessionState.terminalTurnIds.has(String(sessionState.activeTurnId))
        ) {
          const turnId = sessionState.activeTurnId;
          const assistant = await waitForTerminalAssistantForTurn(sessionState, turnId);
          if (assistant) {
            await publishAssistantCompletion(sessionState, assistant);
            break;
          }
          sessionState.terminalTurnIds.add(String(turnId));
          setState(sessionState, { activeTurnId: undefined, status: "ready" });
          await runPromise(
            publishRuntimeEvents([
              {
                ...runtimeEventBase({
                  threadId: sessionState.threadId,
                  createdAt: nowIso(),
                  turnId,
                }),
                type: "turn.aborted",
                payload: {
                  reason: "OpenCode session became idle before completing the active turn.",
                },
              },
            ]),
          );
        } else {
          setState(sessionState, { status: "ready" });
        }
        break;
      }

      case "message.part.updated": {
        const part = event.properties.part;
        sessionState.knownPartKinds.set(part.id, part.type);

        if (part.type !== "tool") {
          break;
        }

        const itemId = toToolItemId(part.callID);
        const turnId = sessionState.activeTurnId ?? sessionState.lastCompletedTurnId;
        const previousStatus = sessionState.knownToolStatuses.get(part.id);
        const itemType = toCanonicalToolItemType(part.tool);
        const detail = summarizeToolDetail(part);
        sessionState.knownToolStatuses.set(part.id, part.state.status);
        sessionState.knownToolsByCallId.set(part.callID, {
          partId: part.id,
          toolName: part.tool,
        });

        const createdAt = nowIso();
        if (!previousStatus) {
          await runPromise(
            publishRuntimeEvents([
              {
                ...runtimeEventBase({
                  threadId: sessionState.threadId,
                  createdAt,
                  turnId,
                  itemId,
                }),
                type: "item.started",
                payload: {
                  itemType,
                  status: "inProgress",
                  title: part.tool,
                  ...(detail ? { detail } : {}),
                  data: part,
                },
              },
            ]),
          );
          break;
        }

        if (part.state.status === "completed" || part.state.status === "error") {
          await runPromise(
            publishRuntimeEvents([
              {
                ...runtimeEventBase({
                  threadId: sessionState.threadId,
                  createdAt,
                  turnId,
                  itemId,
                }),
                type: "item.completed",
                payload: {
                  itemType,
                  status: part.state.status === "completed" ? "completed" : "failed",
                  title: part.state.status === "completed" ? part.state.title : part.tool,
                  ...(detail ? { detail } : {}),
                  data: part,
                },
              },
            ]),
          );
          break;
        }

        await runPromise(
          publishRuntimeEvents([
            {
              ...runtimeEventBase({
                threadId: sessionState.threadId,
                createdAt,
                turnId,
                itemId,
              }),
              type: "item.updated",
              payload: {
                itemType,
                status: "inProgress",
                title: part.tool,
                ...(detail ? { detail } : {}),
                data: part,
              },
            },
          ]),
        );
        break;
      }

      case "message.part.delta": {
        if (event.properties.field !== "text") {
          break;
        }

        const partKind = sessionState.knownPartKinds.get(event.properties.partID);
        const turnId = sessionState.activeTurnId;
        if (!turnId) {
          break;
        }

        await runPromise(
          publishRuntimeEvents([
            {
              ...runtimeEventBase({
                threadId: sessionState.threadId,
                createdAt: nowIso(),
                turnId,
              }),
              type: "content.delta",
              payload: {
                streamKind: partKind === "reasoning" ? "reasoning_text" : "assistant_text",
                delta: event.properties.delta,
              },
            },
          ]),
        );
        break;
      }

      case "message.updated": {
        if (event.properties.info.role !== "assistant") {
          break;
        }

        const assistant = event.properties.info;
        const terminal =
          assistant.time.completed !== undefined ||
          assistant.finish !== undefined ||
          assistant.error;
        if (!terminal) {
          break;
        }
        await publishAssistantCompletion(sessionState, assistant);
        break;
      }

      case "permission.asked": {
        const toolName = event.properties.tool
          ? sessionState.knownToolsByCallId.get(event.properties.tool.callID)?.toolName
          : undefined;
        const requestType = toCanonicalRequestType({
          permission: event.properties.permission,
          ...(toolName ? { toolName } : {}),
        });
        const turnId = sessionState.activeTurnId;
        const itemId = event.properties.tool
          ? toToolItemId(event.properties.tool.callID)
          : undefined;
        sessionState.pendingRequests.set(event.properties.id, {
          kind: "permission",
          requestType,
          turnId,
          itemId,
        });

        await runPromise(
          publishRuntimeEvents([
            {
              ...runtimeEventBase({
                threadId: sessionState.threadId,
                createdAt: nowIso(),
                turnId,
                itemId,
                requestId: RuntimeRequestId.makeUnsafe(event.properties.id),
              }),
              type: "request.opened",
              payload: {
                requestType,
                ...(summarizePermissionDetail(event.properties.patterns)
                  ? { detail: summarizePermissionDetail(event.properties.patterns) }
                  : {}),
                args: event.properties,
              },
            },
          ]),
        );
        break;
      }

      case "permission.replied": {
        const pending = sessionState.pendingRequests.get(event.properties.requestID);
        if (!pending || pending.kind !== "permission") {
          break;
        }
        sessionState.pendingRequests.delete(event.properties.requestID);
        await runPromise(
          publishRuntimeEvents([
            {
              ...runtimeEventBase({
                threadId: sessionState.threadId,
                createdAt: nowIso(),
                turnId: pending.turnId,
                itemId: pending.itemId,
                requestId: RuntimeRequestId.makeUnsafe(event.properties.requestID),
              }),
              type: "request.resolved",
              payload: {
                requestType: pending.requestType,
                resolution: event.properties,
              },
            },
          ]),
        );
        break;
      }

      case "question.asked": {
        const turnId = sessionState.activeTurnId;
        const itemId = event.properties.tool
          ? toToolItemId(event.properties.tool.callID)
          : undefined;
        sessionState.pendingRequests.set(event.properties.id, {
          kind: "question",
          turnId,
          itemId,
          questions: event.properties.questions.map((question) => ({
            id: question.header,
            ...(question.multiple !== undefined ? { multiple: question.multiple } : {}),
            ...(question.custom !== undefined ? { custom: question.custom } : {}),
          })),
        });

        await runPromise(
          publishRuntimeEvents([
            {
              ...runtimeEventBase({
                threadId: sessionState.threadId,
                createdAt: nowIso(),
                turnId,
                itemId,
                requestId: RuntimeRequestId.makeUnsafe(event.properties.id),
              }),
              type: "user-input.requested",
              payload: {
                questions: event.properties.questions.map((question) => ({
                  id: question.header,
                  header: question.header,
                  question: question.question,
                  options: question.options,
                  ...(question.multiple !== undefined ? { multiple: question.multiple } : {}),
                  ...(question.custom !== undefined ? { custom: question.custom } : {}),
                })),
              },
            },
          ]),
        );
        break;
      }

      case "question.replied": {
        const pending = sessionState.pendingRequests.get(event.properties.requestID);
        if (!pending || pending.kind !== "question") {
          break;
        }
        sessionState.pendingRequests.delete(event.properties.requestID);
        await runPromise(
          publishRuntimeEvents([
            {
              ...runtimeEventBase({
                threadId: sessionState.threadId,
                createdAt: nowIso(),
                turnId: pending.turnId,
                itemId: pending.itemId,
                requestId: RuntimeRequestId.makeUnsafe(event.properties.requestID),
              }),
              type: "user-input.resolved",
              payload: {
                answers: toUserInputAnswerRecord(pending, event.properties.answers),
              },
            },
          ]),
        );
        break;
      }

      case "question.rejected": {
        const pending = sessionState.pendingRequests.get(event.properties.requestID);
        if (!pending || pending.kind !== "question") {
          break;
        }
        sessionState.pendingRequests.delete(event.properties.requestID);
        await runPromise(
          publishRuntimeEvents([
            {
              ...runtimeEventBase({
                threadId: sessionState.threadId,
                createdAt: nowIso(),
                turnId: pending.turnId,
                itemId: pending.itemId,
                requestId: RuntimeRequestId.makeUnsafe(event.properties.requestID),
              }),
              type: "user-input.resolved",
              payload: {
                answers: {},
              },
            },
          ]),
        );
        break;
      }

      case "todo.updated": {
        const turnId = sessionState.activeTurnId ?? sessionState.lastCompletedTurnId;
        if (!turnId) {
          break;
        }
        await runPromise(
          publishRuntimeEvents([
            {
              ...runtimeEventBase({
                threadId: sessionState.threadId,
                createdAt: nowIso(),
                turnId,
              }),
              type: "turn.plan.updated",
              payload: {
                plan: event.properties.todos.map((todo) => ({
                  step: todo.content,
                  status: toRuntimePlanStepStatus(todo.status),
                })),
              },
            },
          ]),
        );
        break;
      }

      case "session.diff": {
        const turnId = sessionState.lastCompletedTurnId ?? sessionState.activeTurnId;
        if (!turnId || event.properties.diff.length === 0) {
          break;
        }
        await runPromise(
          publishRuntimeEvents([
            {
              ...runtimeEventBase({
                threadId: sessionState.threadId,
                createdAt: nowIso(),
                turnId,
              }),
              type: "turn.diff.updated",
              payload: {
                unifiedDiff: buildOpenCodeDiffSummary(event.properties.diff),
              },
            },
          ]),
        );
        break;
      }

      case "session.error": {
        if (
          isAbortSessionError(event.properties.error) &&
          sessionState.abortErrorSuppressionUntil !== undefined &&
          Date.now() <= sessionState.abortErrorSuppressionUntil
        ) {
          setState(sessionState, { abortErrorSuppressionUntil: undefined });
          break;
        }

        const message = event.properties.error
          ? toOpenCodeErrorMessage(event.properties.error)
          : undefined;
        if (!message) {
          break;
        }
        setState(sessionState, {
          abortErrorSuppressionUntil: undefined,
          status: "error",
          lastError: message,
        });
        await runPromise(
          publishRuntimeEvents([
            {
              ...runtimeEventBase({
                threadId: sessionState.threadId,
                createdAt: nowIso(),
                turnId: sessionState.activeTurnId,
              }),
              type: "runtime.error",
              payload: {
                message,
                class: "provider_error",
                detail: event.properties,
              },
            },
          ]),
        );
        break;
      }

      default:
        break;
    }
  };

  yield* Effect.forkScoped(
    Stream.runForEach(pool.streamEvents, (event) =>
      Effect.gen(function* () {
        if (event.expected) {
          return;
        }

        const affected = activeSessionsForKey(event.key);
        for (const state of affected) {
          sessions.delete(state.threadId);
          threadIdBySessionId.delete(state.sessionId);
        }
        yield* stopWatcherIfUnused(event.key);

        const runtimeEvents = affected.flatMap((state) => {
          const events: Array<ProviderRuntimeEvent> = [];
          if (state.activeTurnId && !state.terminalTurnIds.has(String(state.activeTurnId))) {
            state.terminalTurnIds.add(String(state.activeTurnId));
            events.push({
              ...runtimeEventBase({
                threadId: state.threadId,
                createdAt: nowIso(),
                turnId: state.activeTurnId,
              }),
              type: "turn.aborted",
              payload: {
                reason: "OpenCode sidecar exited unexpectedly.",
              },
            });
          }

          events.push(
            {
              ...runtimeEventBase({
                threadId: state.threadId,
                createdAt: nowIso(),
              }),
              type: "session.exited",
              payload: {
                reason: event.detail ?? "OpenCode sidecar exited unexpectedly.",
                recoverable: true,
                exitKind: "error",
              },
            },
            {
              ...runtimeEventBase({
                threadId: state.threadId,
                createdAt: nowIso(),
              }),
              type: "runtime.error",
              payload: {
                message: event.detail ?? "OpenCode sidecar exited unexpectedly.",
                class: "transport_error",
              },
            },
          );

          return events;
        });

        if (runtimeEvents.length > 0) {
          yield* publishRuntimeEvents(runtimeEvents);
        }
      }),
    ),
  );

  const startSession: OpenCodeAdapterShape["startSession"] = (input) =>
    Effect.gen(function* () {
      if (input.provider !== undefined && input.provider !== PROVIDER) {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "startSession",
          issue: `Expected provider '${PROVIDER}' but received '${input.provider}'.`,
        });
      }

      const existing = getStateByThreadId(input.threadId);
      if (existing) {
        yield* existing.lease.release;
        sessions.delete(existing.threadId);
        threadIdBySessionId.delete(existing.sessionId);
        yield* stopWatcherIfUnused(existing.lease.key);
      }

      const cwd = input.cwd ?? process.cwd();
      const poolRoot = input.poolRoot ?? cwd;
      const binaryPath =
        input.providerOptions?.opencode?.binaryPath ??
        (yield* serverSettingsService.getSettings.pipe(
          Effect.map((settings) => settings.providers.opencode.binaryPath),
          Effect.mapError(
            (error) =>
              new ProviderAdapterProcessError({
                provider: PROVIDER,
                threadId: input.threadId,
                detail: error.message,
                cause: error,
              }),
          ),
        ));
      const lease = yield* pool.acquire(
        binaryPath ? { cwd, poolRoot, binaryPath } : { cwd, poolRoot },
      );

      const sessionIdFromResumeCursor = readSessionIdFromResumeCursor(input.resumeCursor);
      const { sessionInfo, resumedExistingSession } = yield* Effect.tryPromise({
        try: async () => {
          if (sessionIdFromResumeCursor) {
            try {
              const recoveredSession = await lease.client.session
                .get({ sessionID: sessionIdFromResumeCursor }, SDK_OPTIONS)
                .then((result) => result.data as Session);
              return {
                sessionInfo: recoveredSession,
                resumedExistingSession: true as const,
              };
            } catch {
              // Fall through to fresh session creation.
            }
          }

          const freshSession = await lease.client.session
            .create(
              {
                title: `T3 ${input.threadId}`,
                permission: buildOpenCodePermissionRules(input.runtimeMode),
              },
              SDK_OPTIONS,
            )
            .then((result) => result.data as Session);
          return {
            sessionInfo: freshSession,
            resumedExistingSession: false as const,
          };
        },
        catch: (cause) =>
          new ProviderAdapterProcessError({
            provider: PROVIDER,
            threadId: input.threadId,
            detail: cause instanceof Error ? cause.message : "Failed to start OpenCode session.",
            ...(cause !== undefined ? { cause } : {}),
          }),
      });

      const resolvedRuntimeMode =
        runtimeModeFromOpenCodePermissionRules(sessionInfo.permission) ?? input.runtimeMode;
      const selectedModel =
        input.modelSelection?.provider === PROVIDER ? input.modelSelection.model : undefined;

      const state: OpenCodeSessionState = {
        threadId: input.threadId,
        createdAt: nowIso(),
        lease,
        sessionId: sessionInfo.id,
        cwd,
        poolRoot,
        ...(binaryPath ? { binaryPath } : {}),
        runtimeMode: resolvedRuntimeMode,
        model: selectedModel,
        status: "ready",
        updatedAt: nowIso(),
        lastError: undefined,
        activeTurnId: undefined,
        lastCompletedTurnId: undefined,
        terminalTurnIds: new Set(),
        knownPartKinds: new Map(),
        knownToolStatuses: new Map(),
        knownToolsByCallId: new Map(),
        pendingRequests: new Map(),
        orderedUserMessageIds: [],
        abortErrorSuppressionUntil: undefined,
      };

      const history = yield* Effect.tryPromise({
        try: () => loadSessionHistorySummary(state),
        catch: (cause) =>
          toRequestError(
            "session.messages",
            cause instanceof Error ? cause.message : "Failed to inspect OpenCode session history.",
            cause,
          ),
      });
      state.orderedUserMessageIds = history.orderedUserMessageIds;
      state.lastCompletedTurnId = history.lastCompletedTurnId;

      sessions.set(input.threadId, state);
      threadIdBySessionId.set(state.sessionId, input.threadId);
      yield* ensureWatcher(state);

      const runtimeEvents: Array<ProviderRuntimeEvent> = [
        {
          ...runtimeEventBase({ threadId: state.threadId, createdAt: state.updatedAt }),
          type: "session.started",
          payload: {
            message: resumedExistingSession
              ? "Recovered OpenCode session."
              : "Started OpenCode session.",
            resume: {
              sessionId: state.sessionId,
            },
          },
        },
        {
          ...runtimeEventBase({ threadId: state.threadId, createdAt: state.updatedAt }),
          type: "thread.started",
          payload: {
            providerThreadId: state.sessionId,
          },
        },
        {
          ...runtimeEventBase({ threadId: state.threadId, createdAt: state.updatedAt }),
          type: "session.state.changed",
          payload: {
            state: "ready",
          },
        },
      ];

      if (history.recoveredAbortedTurnId) {
        state.terminalTurnIds.add(String(history.recoveredAbortedTurnId));
        runtimeEvents.push({
          ...runtimeEventBase({
            threadId: state.threadId,
            createdAt: state.updatedAt,
            turnId: history.recoveredAbortedTurnId,
          }),
          type: "turn.aborted",
          payload: {
            reason:
              "Recovered OpenCode session after sidecar loss; the in-flight turn cannot be resumed.",
          },
        });
      }

      yield* publishRuntimeEvents(runtimeEvents);
      return toProviderSessionSnapshot(state);
    });

  const sendTurn: OpenCodeAdapterShape["sendTurn"] = (input) =>
    Effect.gen(function* () {
      const state = getStateByThreadId(input.threadId);
      if (!state) {
        return yield* missingSession(input.threadId);
      }

      const parts: Array<
        | {
            readonly type: "text";
            readonly text: string;
          }
        | {
            readonly type: "file";
            readonly mime: string;
            readonly filename: string;
            readonly url: string;
          }
      > = [];
      if (input.input) {
        parts.push({ type: "text", text: input.input });
      }

      const attachments = yield* Effect.forEach(
        input.attachments ?? [],
        (attachment) =>
          Effect.gen(function* () {
            const attachmentPath = resolveAttachmentPath({
              attachmentsDir: serverConfig.attachmentsDir,
              attachment,
            });
            if (!attachmentPath) {
              return yield* new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "session.promptAsync",
                detail: `Invalid attachment id '${attachment.id}'.`,
              });
            }

            const bytes = yield* fileSystem
              .readFile(attachmentPath)
              .pipe(
                Effect.mapError((cause) =>
                  toRequestError(
                    "session.promptAsync",
                    cause instanceof Error ? cause.message : "Failed to read attachment file.",
                    cause,
                  ),
                ),
              );
            return {
              type: "file" as const,
              mime: attachment.mimeType,
              filename: attachment.name,
              url: `data:${attachment.mimeType};base64,${Buffer.from(bytes).toString("base64")}`,
            };
          }),
        { concurrency: 1 },
      );
      parts.push(...attachments);

      if (parts.length === 0) {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "sendTurn",
          issue: "Turn input must include text or attachments.",
        });
      }

      const openCodeMessageId = `msg_${randomUUID()}`;
      const turnId = toTurnIdForUserMessage(openCodeMessageId);
      const selectedModel =
        input.modelSelection?.provider === PROVIDER
          ? toOpenCodeModel(input.modelSelection.model)
          : undefined;
      const selectedModelSlug =
        input.modelSelection?.provider === PROVIDER ? input.modelSelection.model : undefined;
      const agent = input.interactionMode === "plan" ? "plan" : "build";

      yield* Effect.tryPromise({
        try: () =>
          state.lease.client.session.promptAsync(
            {
              sessionID: state.sessionId,
              messageID: openCodeMessageId,
              ...(selectedModel ? { model: selectedModel } : {}),
              agent,
              parts,
            },
            SDK_OPTIONS,
          ),
        catch: (cause) =>
          toRequestError(
            "session.promptAsync",
            cause instanceof Error ? cause.message : "Failed to start OpenCode turn.",
            cause,
          ),
      });

      state.orderedUserMessageIds.push(openCodeMessageId);
      setState(state, {
        activeTurnId: turnId,
        abortErrorSuppressionUntil: undefined,
        status: "running",
        model: selectedModelSlug ?? state.model,
        lastError: undefined,
      });

      yield* publishRuntimeEvents([
        {
          ...runtimeEventBase({
            threadId: state.threadId,
            createdAt: state.updatedAt,
            turnId,
          }),
          type: "turn.started",
          payload: selectedModelSlug ? { model: selectedModelSlug } : {},
        },
      ]);

      return {
        threadId: input.threadId,
        turnId,
        resumeCursor: { sessionId: state.sessionId },
      } satisfies ProviderTurnStartResult;
    });

  const interruptTurn: OpenCodeAdapterShape["interruptTurn"] = (threadId, turnId) =>
    Effect.gen(function* () {
      const state = getStateByThreadId(threadId);
      if (!state) {
        return yield* missingSession(threadId);
      }

      const activeTurnId = turnId ?? state.activeTurnId;
      if (activeTurnId) {
        setState(state, {
          abortErrorSuppressionUntil: Date.now() + USER_ABORT_ERROR_SUPPRESSION_WINDOW_MS,
        });
      }
      yield* Effect.tryPromise({
        try: () => state.lease.client.session.abort({ sessionID: state.sessionId }, SDK_OPTIONS),
        catch: (cause) =>
          toRequestError(
            "session.abort",
            cause instanceof Error ? cause.message : "Failed to interrupt OpenCode turn.",
            cause,
          ),
      });

      if (activeTurnId && !state.terminalTurnIds.has(String(activeTurnId))) {
        state.terminalTurnIds.add(String(activeTurnId));
        setState(state, { activeTurnId: undefined, status: "ready" });
        yield* publishRuntimeEvents([
          {
            ...runtimeEventBase({ threadId, createdAt: state.updatedAt, turnId: activeTurnId }),
            type: "turn.aborted",
            payload: {
              reason: "Turn interrupted by user.",
            },
          },
        ]);
      }
    });

  const respondToRequest: OpenCodeAdapterShape["respondToRequest"] = (
    threadId,
    requestId,
    decision,
  ) =>
    Effect.gen(function* () {
      const state = getStateByThreadId(threadId);
      if (!state) {
        return yield* missingSession(threadId);
      }

      yield* Effect.tryPromise({
        try: () =>
          state.lease.client.permission.reply(
            {
              requestID: requestId,
              reply: toApprovalReply(decision),
            },
            SDK_OPTIONS,
          ),
        catch: (cause) =>
          toRequestError(
            "permission.reply",
            cause instanceof Error
              ? cause.message
              : "Failed to reply to OpenCode permission request.",
            cause,
          ),
      });
    });

  const respondToUserInput: OpenCodeAdapterShape["respondToUserInput"] = (
    threadId,
    requestId,
    answers,
  ) =>
    Effect.gen(function* () {
      const state = getStateByThreadId(threadId);
      if (!state) {
        return yield* missingSession(threadId);
      }

      const pending = state.pendingRequests.get(requestId);
      if (!pending || pending.kind !== "question") {
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "question.reply",
          detail: `Unknown pending OpenCode question request '${requestId}'.`,
        });
      }

      yield* Effect.tryPromise({
        try: () =>
          state.lease.client.question.reply(
            {
              requestID: requestId,
              answers: toQuestionAnswers(pending, answers),
            },
            SDK_OPTIONS,
          ),
        catch: (cause) =>
          toRequestError(
            "question.reply",
            cause instanceof Error ? cause.message : "Failed to reply to OpenCode question.",
            cause,
          ),
      });
    });

  const stopSession: OpenCodeAdapterShape["stopSession"] = (threadId) =>
    Effect.gen(function* () {
      const state = getStateByThreadId(threadId);
      if (!state) {
        return;
      }

      if (state.activeTurnId && !state.terminalTurnIds.has(String(state.activeTurnId))) {
        yield* Effect.tryPromise({
          try: () => state.lease.client.session.abort({ sessionID: state.sessionId }, SDK_OPTIONS),
          catch: (cause) =>
            toRequestError(
              "session.abort",
              cause instanceof Error ? cause.message : "Failed to interrupt OpenCode turn.",
              cause,
            ),
        }).pipe(Effect.catch(() => Effect.void));
      }

      sessions.delete(threadId);
      threadIdBySessionId.delete(state.sessionId);
      yield* state.lease.release;
      yield* stopWatcherIfUnused(state.lease.key);
    });

  const listSessions: OpenCodeAdapterShape["listSessions"] = () =>
    Effect.sync(() => Array.from(sessions.values(), toProviderSessionSnapshot));

  const hasSession: OpenCodeAdapterShape["hasSession"] = (threadId) =>
    Effect.succeed(sessions.has(threadId));

  const readThread: OpenCodeAdapterShape["readThread"] = (threadId) =>
    Effect.gen(function* () {
      const state = getStateByThreadId(threadId);
      if (!state) {
        return yield* missingSession(threadId);
      }

      const messages = yield* Effect.tryPromise({
        try: () => loadMessages(state),
        catch: (cause) =>
          toRequestError(
            "session.messages",
            cause instanceof Error ? cause.message : "Failed to read OpenCode session messages.",
            cause,
          ),
      });

      const turns = messages
        .filter((entry) => entry.info.role === "user")
        .map((entry) => {
          const relatedMessages = messages.filter(
            (candidate) =>
              candidate.info.id === entry.info.id ||
              (candidate.info.role === "assistant" && candidate.info.parentID === entry.info.id),
          );
          return {
            id: toTurnIdForUserMessage(entry.info.id),
            items: relatedMessages,
          };
        });

      return {
        threadId,
        turns,
      } satisfies ProviderThreadSnapshot;
    });

  const rollbackThread: OpenCodeAdapterShape["rollbackThread"] = (threadId, numTurns) =>
    Effect.gen(function* () {
      const state = getStateByThreadId(threadId);
      if (!state) {
        return yield* missingSession(threadId);
      }

      if (!Number.isInteger(numTurns) || numTurns < 1) {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "rollbackThread",
          issue: "numTurns must be an integer >= 1.",
        });
      }

      const messages = yield* Effect.tryPromise({
        try: () => loadMessages(state),
        catch: (cause) =>
          toRequestError(
            "session.messages",
            cause instanceof Error ? cause.message : "Failed to read OpenCode session history.",
            cause,
          ),
      });
      const userMessages = messages.filter((entry) => entry.info.role === "user");
      if (userMessages.length === 0) {
        return {
          threadId,
          turns: [],
        } satisfies ProviderThreadSnapshot;
      }

      const boundaryIndex = Math.max(0, userMessages.length - numTurns);
      const boundaryMessage = userMessages[boundaryIndex];
      const nextSession = yield* Effect.tryPromise({
        try: () =>
          boundaryMessage
            ? state.lease.client.session
                .fork(
                  {
                    sessionID: state.sessionId,
                    messageID: boundaryMessage.info.id,
                  },
                  SDK_OPTIONS,
                )
                .then((result) => result.data as Session)
            : state.lease.client.session
                .create(
                  {
                    title: `T3 ${threadId}`,
                    permission: buildOpenCodePermissionRules(state.runtimeMode),
                  },
                  SDK_OPTIONS,
                )
                .then((result) => result.data as Session),
        catch: (cause) =>
          toRequestError(
            "session.fork",
            cause instanceof Error ? cause.message : "Failed to fork OpenCode session.",
            cause,
          ),
      });

      threadIdBySessionId.delete(state.sessionId);
      state.sessionId = nextSession.id;
      threadIdBySessionId.set(state.sessionId, threadId);
      state.terminalTurnIds.clear();
      state.knownPartKinds.clear();
      state.knownToolStatuses.clear();
      state.knownToolsByCallId.clear();
      state.pendingRequests.clear();
      setState(state, {
        activeTurnId: undefined,
        lastError: undefined,
        status: "ready",
      });

      const history = yield* Effect.tryPromise({
        try: () => loadSessionHistorySummary(state),
        catch: (cause) =>
          toRequestError(
            "session.messages",
            cause instanceof Error ? cause.message : "Failed to reload OpenCode session history.",
            cause,
          ),
      });
      state.orderedUserMessageIds = history.orderedUserMessageIds;
      state.lastCompletedTurnId = history.lastCompletedTurnId;

      return yield* readThread(threadId);
    });

  const stopAll: OpenCodeAdapterShape["stopAll"] = () =>
    Effect.gen(function* () {
      const threadIds = Array.from(sessions.keys());
      for (const threadId of threadIds) {
        yield* stopSession(threadId);
      }
    });

  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      yield* stopAll().pipe(Effect.catch(() => Effect.void));
      yield* Queue.shutdown(runtimeEventQueue);
    }),
  );

  return {
    provider: PROVIDER,
    capabilities: {
      sessionModelSwitch: "restart-session",
    },
    startSession,
    sendTurn,
    interruptTurn,
    respondToRequest,
    respondToUserInput,
    stopSession,
    listSessions,
    hasSession,
    readThread,
    rollbackThread,
    stopAll,
    streamEvents: Stream.fromQueue(runtimeEventQueue),
  } satisfies OpenCodeAdapterShape;
});

function resolveSessionForEvent(
  event: Event,
  getStateBySessionId: (sessionId: string) => OpenCodeSessionState | undefined,
): OpenCodeSessionState | undefined {
  const maybeProperties = "properties" in event ? event.properties : undefined;
  if (!maybeProperties || typeof maybeProperties !== "object") {
    return undefined;
  }
  const sessionId = "sessionID" in maybeProperties ? maybeProperties.sessionID : undefined;
  return typeof sessionId === "string" ? getStateBySessionId(sessionId) : undefined;
}

export const OpenCodeAdapterLive = Layer.effect(OpenCodeAdapter, makeOpenCodeAdapter);
