import * as NodeAssert from "node:assert/strict";

import { it } from "@effect/vitest";
import { EventId, ProviderDriverKind, ThreadId, TurnId } from "@t3tools/contracts";
import type { OpencodeClient, Part } from "@opencode-ai/sdk/v2";
import * as Effect from "effect/Effect";

import {
  completeOpenCodeTurnFromTerminalAssistant,
  hasSettledOpenCodePartForMessage,
  openCodeSessionTitle,
  reAdoptOpenCodeSession,
  selectReusableOpenCodeSession,
  supportsLegacyOpenCodeResumeCursor,
  terminalAssistantMessageFromInfo,
} from "./OpenCodeAdapterRecovery.ts";

it("accepts only the unversioned legacy resume-cursor shape", () => {
  NodeAssert.equal(supportsLegacyOpenCodeResumeCursor({ sessionId: "ses_legacy" }), true);
  NodeAssert.equal(supportsLegacyOpenCodeResumeCursor({ schemaVersion: 1 }), false);
  NodeAssert.equal(supportsLegacyOpenCodeResumeCursor({ schemaVersion: null }), false);
});

it("selects the oldest session with the fork-owned thread title in the requested directory", () => {
  const threadId = ThreadId.make("thread-opencode-title-fallback");
  const session = selectReusableOpenCodeSession({
    sessions: [
      {
        id: "opencode-session-new-duplicate",
        title: openCodeSessionTitle(threadId),
        directory: "/workspace",
        time: { created: 20, updated: 20 },
      },
      {
        id: "opencode-session-original",
        title: openCodeSessionTitle(threadId),
        directory: "/workspace",
        time: { created: 10, updated: 30 },
      },
      {
        id: "opencode-session-other-directory",
        title: openCodeSessionTitle(threadId),
        directory: "/other-workspace",
        time: { created: 1, updated: 1 },
      },
    ] as never,
    threadId,
    directory: "/workspace",
  });

  NodeAssert.equal(openCodeSessionTitle(threadId), `T3 Code ${threadId}`);
  NodeAssert.equal(session?.id, "opencode-session-original");
});

it.effect("re-adopts the selected titled session and reapplies its permission rules", () =>
  Effect.gen(function* () {
    const calls: Array<{ readonly operation: string; readonly input: unknown }> = [];
    const client = {
      session: {
        list: async (input: unknown) => {
          calls.push({ operation: "list", input });
          return {
            data: [
              {
                id: "opencode-session-original",
                title: "T3 Code thread-opencode-re-adopt",
                directory: "/workspace",
                time: { created: 10, updated: 30 },
              },
            ],
          };
        },
        update: async (input: unknown) => {
          calls.push({ operation: "update", input });
          return { data: { id: "opencode-session-original" } };
        },
      },
    } as unknown as OpencodeClient;

    const session = yield* reAdoptOpenCodeSession({
      client,
      threadId: ThreadId.make("thread-opencode-re-adopt"),
      directory: "/workspace",
      runtimeMode: "full-access",
    });

    NodeAssert.equal(session?.id, "opencode-session-original");
    NodeAssert.deepEqual(calls, [
      {
        operation: "list",
        input: {
          directory: "/workspace",
          search: "thread-opencode-re-adopt",
          limit: 50,
        },
      },
      {
        operation: "update",
        input: {
          sessionID: "opencode-session-original",
          permission: [
            { permission: "*", pattern: "*", action: "allow" },
            { permission: "external_directory", pattern: "*", action: "allow" },
          ],
        },
      },
    ]);
  }),
);

it("recognizes terminal assistant messages and waits for a settled part", () => {
  const terminal = terminalAssistantMessageFromInfo({
    role: "assistant",
    time: { completed: 42 },
    error: { message: " OpenCode failed " },
  });
  const parts = [
    {
      id: "part-running",
      messageID: "message-terminal",
      type: "text",
      time: { start: 1 },
    },
    {
      id: "part-settled",
      messageID: "message-terminal",
      type: "text",
      time: { start: 1, end: 2 },
    },
  ] as unknown as ReadonlyArray<Part>;

  NodeAssert.deepEqual(terminal, {
    completedAt: 42,
    state: "failed",
    errorMessage: "OpenCode failed",
  });
  NodeAssert.equal(hasSettledOpenCodePartForMessage(parts, "message-terminal"), true);
});

it.effect("settles a completed terminal assistant message through the adapter callbacks", () =>
  Effect.gen(function* () {
    const threadId = ThreadId.make("thread-opencode-terminal-message");
    const turnId = TurnId.make("turn-opencode-terminal-message");
    const context = {
      session: { threadId },
      terminalAssistantMessages: new Map([
        ["message-terminal", { completedAt: 42, state: "completed" as const }],
      ]),
      activeTurnId: turnId,
      activeAgent: "build",
      activeVariant: "high",
    };
    const updates: Array<unknown> = [];
    const emitted: Array<unknown> = [];

    yield* completeOpenCodeTurnFromTerminalAssistant<typeof context, never, never>({
      context,
      messageId: "message-terminal",
      raw: { source: "test" },
      isoFromEpochMs: (value) => `timestamp-${value}`,
      updateProviderSession: (_context, patch, options) =>
        Effect.sync(() => {
          updates.push({ patch, options });
        }),
      buildEventBase: ({ threadId: eventThreadId, turnId: eventTurnId, createdAt, raw }) =>
        Effect.succeed({
          eventId: EventId.make("event-opencode-terminal-message"),
          provider: ProviderDriverKind.make("opencode"),
          threadId: eventThreadId,
          turnId: eventTurnId,
          createdAt: createdAt ?? "now",
          raw: {
            source: "opencode.sdk.event" as const,
            payload: raw,
          },
        }),
      emit: (event) =>
        Effect.sync(() => {
          emitted.push(event);
        }),
    });

    NodeAssert.equal(context.terminalAssistantMessages.size, 0);
    NodeAssert.equal(context.activeTurnId, undefined);
    NodeAssert.equal(context.activeAgent, undefined);
    NodeAssert.equal(context.activeVariant, undefined);
    NodeAssert.deepEqual(updates, [
      {
        patch: { status: "ready" },
        options: { clearActiveTurnId: true, clearLastError: true },
      },
    ]);
    NodeAssert.deepEqual(emitted, [
      {
        eventId: "event-opencode-terminal-message",
        provider: "opencode",
        threadId: "thread-opencode-terminal-message",
        turnId: "turn-opencode-terminal-message",
        createdAt: "timestamp-42",
        raw: {
          source: "opencode.sdk.event",
          payload: { source: "test" },
        },
        type: "turn.completed",
        payload: { state: "completed" },
      },
    ]);
  }),
);
