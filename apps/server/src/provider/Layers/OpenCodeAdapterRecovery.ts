import type {
  ProviderRuntimeEvent,
  ProviderSession,
  RuntimeMode,
  ThreadId,
} from "@t3tools/contracts";
import type { OpencodeClient, Part, Session as OpenCodeSdkSession } from "@opencode-ai/sdk/v2";
import * as Effect from "effect/Effect";

import {
  buildOpenCodePermissionRules,
  runOpenCodeSdk,
  type OpenCodeServerConnection,
} from "../opencodeRuntime.ts";

/** Accept the unversioned cursor shape written before cursor versioning landed. */
export function supportsLegacyOpenCodeResumeCursor(
  record: Readonly<Record<string, unknown>>,
): boolean {
  return record.schemaVersion === undefined;
}

export function openCodeSessionTitle(threadId: ThreadId): string {
  return `T3 Code ${threadId}`;
}

export function selectReusableOpenCodeSession(input: {
  readonly sessions: ReadonlyArray<OpenCodeSdkSession>;
  readonly threadId: ThreadId;
  readonly directory: string;
}): OpenCodeSdkSession | undefined {
  const title = openCodeSessionTitle(input.threadId);
  return input.sessions
    .filter((session) => session.title === title && session.directory === input.directory)
    .toSorted((left, right) => left.time.created - right.time.created)[0];
}

export function reAdoptOpenCodeSession(input: {
  readonly client: OpencodeClient;
  readonly threadId: ThreadId;
  readonly directory: string;
  readonly runtimeMode: RuntimeMode;
}) {
  return Effect.gen(function* () {
    const existingSessions = yield* runOpenCodeSdk("session.list", () =>
      input.client.session.list({
        directory: input.directory,
        search: input.threadId,
        limit: 50,
      }),
    );
    const titledSession = selectReusableOpenCodeSession({
      sessions: existingSessions.data ?? [],
      threadId: input.threadId,
      directory: input.directory,
    });
    if (!titledSession) {
      return undefined;
    }

    yield* runOpenCodeSdk("session.update", () =>
      input.client.session.update({
        sessionID: titledSession.id,
        permission: buildOpenCodePermissionRules(input.runtimeMode),
      }),
    );
    return titledSession;
  });
}

export interface TerminalAssistantMessage {
  readonly completedAt: number;
  readonly state: "completed" | "failed";
  readonly errorMessage?: string;
}

export function terminalAssistantMessageFromInfo(info: {
  readonly role?: unknown;
  readonly time?: { readonly completed?: unknown };
  readonly finish?: unknown;
  readonly error?: unknown;
}): TerminalAssistantMessage | undefined {
  if (info.role !== "assistant") {
    return undefined;
  }
  const completedAt = info.time?.completed;
  if (typeof completedAt !== "number" || !Number.isFinite(completedAt)) {
    return undefined;
  }
  const finish = typeof info.finish === "string" ? info.finish : undefined;
  const hasTerminalFinish =
    finish !== undefined && finish.length > 0 && finish !== "tool-calls" && finish !== "unknown";
  const hasError = info.error !== undefined;
  if (!hasTerminalFinish && !hasError) {
    return undefined;
  }
  return {
    completedAt,
    state: hasError ? "failed" : "completed",
    ...(hasError
      ? { errorMessage: openCodeAssistantErrorMessage(info.error) ?? "OpenCode turn failed." }
      : {}),
  };
}

function openCodeAssistantErrorMessage(error: unknown): string | undefined {
  if (!error || typeof error !== "object") {
    return undefined;
  }
  const message = (error as { readonly message?: unknown }).message;
  return typeof message === "string" && message.trim().length > 0 ? message.trim() : undefined;
}

function isSettledOpenCodePart(part: Part): boolean {
  switch (part.type) {
    case "text":
    case "reasoning":
      return part.time?.end !== undefined;
    case "tool":
      return part.state.status === "completed" || part.state.status === "error";
    case "step-finish":
      return true;
    default:
      return false;
  }
}

export function hasSettledOpenCodePartForMessage(
  parts: Iterable<Part>,
  messageId: string,
): boolean {
  for (const part of parts) {
    if (part.messageID === messageId && isSettledOpenCodePart(part)) {
      return true;
    }
  }
  return false;
}

export interface OpenCodeTerminalAssistantMessageContext {
  readonly session: Pick<ProviderSession, "threadId">;
  readonly terminalAssistantMessages: Map<string, TerminalAssistantMessage>;
  activeTurnId: ProviderSession["activeTurnId"];
  activeAgent: string | undefined;
  activeVariant: string | undefined;
}

type OpenCodeTurnCompletedEvent = Extract<
  ProviderRuntimeEvent,
  { readonly type: "turn.completed" }
>;
type OpenCodeTurnCompletedEventBase = Omit<OpenCodeTurnCompletedEvent, "type" | "payload">;

export function completeOpenCodeTurnFromTerminalAssistant<
  Context extends OpenCodeTerminalAssistantMessageContext,
  E,
  R,
>(input: {
  readonly context: Context;
  readonly messageId: string;
  readonly raw: unknown;
  readonly isoFromEpochMs: (value: number) => string | undefined;
  readonly updateProviderSession: (
    context: Context,
    patch: Partial<ProviderSession>,
    options: {
      readonly clearActiveTurnId?: boolean;
      readonly clearLastError?: boolean;
    },
  ) => Effect.Effect<unknown, E, R>;
  readonly buildEventBase: (input: {
    readonly threadId: ThreadId;
    readonly turnId: NonNullable<ProviderSession["activeTurnId"]>;
    readonly createdAt: string | undefined;
    readonly raw: unknown;
  }) => Effect.Effect<OpenCodeTurnCompletedEventBase, E, R>;
  readonly emit: (event: OpenCodeTurnCompletedEvent) => Effect.Effect<unknown, E, R>;
}): Effect.Effect<void, E, R> {
  return Effect.gen(function* () {
    const terminal = input.context.terminalAssistantMessages.get(input.messageId);
    const turnId = input.context.activeTurnId;
    if (!terminal || !turnId) {
      return;
    }
    input.context.terminalAssistantMessages.delete(input.messageId);
    input.context.activeTurnId = undefined;
    input.context.activeAgent = undefined;
    input.context.activeVariant = undefined;
    yield* input.updateProviderSession(
      input.context,
      {
        status: terminal.state === "failed" ? "error" : "ready",
        ...(terminal.state === "failed" && terminal.errorMessage
          ? { lastError: terminal.errorMessage }
          : {}),
      },
      {
        clearActiveTurnId: true,
        clearLastError: terminal.state === "completed",
      },
    );
    yield* input.emit({
      ...(yield* input.buildEventBase({
        threadId: input.context.session.threadId,
        turnId,
        createdAt: input.isoFromEpochMs(terminal.completedAt),
        raw: input.raw,
      })),
      type: "turn.completed",
      payload: {
        state: terminal.state,
        ...(terminal.errorMessage ? { errorMessage: terminal.errorMessage } : {}),
      },
    });
  });
}

export function logOpenCodeSessionLifecycle(
  phase: "connected" | "stopping" | "stopped",
  context: {
    readonly session: Pick<ProviderSession, "threadId" | "providerInstanceId">;
    readonly openCodeSessionId: string;
    readonly server: Pick<OpenCodeServerConnection, "url" | "processId" | "external">;
  },
) {
  return Effect.logInfo(`opencode provider session ${phase}`, {
    threadId: context.session.threadId,
    providerInstanceId: context.session.providerInstanceId,
    openCodeSessionId: context.openCodeSessionId,
    serverUrl: context.server.url,
    serverProcessId: context.server.processId,
    externalServer: context.server.external,
  });
}
