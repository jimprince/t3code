import { assert, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as McpProviderSessions from "./McpProviderSessions.ts";
import type { McpProviderSessionConfig } from "./mcpSession.ts";

const threadId = ThreadId.make("thread-mcp-providers");
const codex = ProviderInstanceId.make("codex");
const claude = ProviderInstanceId.make("claudeAgent");
const config = (
  providerInstanceId: ProviderInstanceId,
  providerSessionId: string,
): McpProviderSessionConfig => ({
  environmentId: EnvironmentId.make("environment-mcp-providers"),
  threadId,
  providerInstanceId,
  providerSessionId,
  endpoint: "http://127.0.0.1:43123/mcp",
  authorizationHeader: `Bearer fixture-${providerSessionId}`,
  browserToolsAvailable: false,
});

it.effect(
  "MCP clients read only their provider's credential and stale cleanup preserves replacements",
  () =>
    Effect.gen(function* () {
      const sessions = yield* McpProviderSessions.McpProviderSessions;
      const original = config(codex, "codex-original");
      const other = config(claude, "claude-original");
      const replacement = config(codex, "codex-replacement");
      yield* sessions.set(original);
      assert.isUndefined(
        yield* sessions.read(threadId, claude),
        "a provider must never borrow another provider's token",
      );
      yield* sessions.set(other);
      assert.deepEqual(yield* sessions.read(threadId, codex), original);
      assert.deepEqual(yield* sessions.read(threadId, claude), other);
      assert.isUndefined(yield* sessions.read(ThreadId.make("another-thread"), codex));
      yield* sessions.set(replacement);
      yield* sessions.clear(threadId, original.providerSessionId);
      assert.deepEqual(yield* sessions.read(threadId, codex), replacement);
      yield* sessions.clear(threadId, replacement.providerSessionId);
      assert.isUndefined(yield* sessions.read(threadId, codex));
      assert.deepEqual(yield* sessions.read(threadId, claude), other);
      yield* sessions.clear(threadId);
      assert.isUndefined(yield* sessions.read(threadId, claude));
    }).pipe(Effect.provide(McpProviderSessions.layer)),
);
