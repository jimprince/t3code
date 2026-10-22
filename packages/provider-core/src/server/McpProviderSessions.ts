/**
 * The T3 MCP credential each thread's provider instance should expose to its
 * agent. The session manager writes it before a session starts; adapters read
 * it when they build provider launch options.
 *
 * @module provider-core/server/McpProviderSessions
 */
import type { ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import type { McpProviderSessionConfig } from "./mcpSession.ts";

export class McpProviderSessions extends Context.Service<
  McpProviderSessions,
  {
    readonly set: (config: McpProviderSessionConfig) => Effect.Effect<void>;
    /** Omit instanceId to inspect the most recently prepared credential. */
    readonly read: (
      threadId: ThreadId,
      instanceId?: ProviderInstanceId,
    ) => Effect.Effect<McpProviderSessionConfig | undefined>;
    /** Omit credentialId only when all providers for the thread must be revoked. */
    readonly clear: (threadId: ThreadId, credentialId?: string) => Effect.Effect<void>;
  }
>()("@t3tools/provider-core/server/McpProviderSessions") {}

const make = Effect.gen(function* () {
  const sessions = yield* Ref.make(
    new Map<ThreadId, ReadonlyMap<ProviderInstanceId, McpProviderSessionConfig>>(),
  );
  return McpProviderSessions.of({
    set: (config) =>
      Ref.update(sessions, (current) => {
        const providers = new Map(current.get(config.threadId));
        providers.delete(config.providerInstanceId);
        providers.set(config.providerInstanceId, config);
        return new Map(current).set(config.threadId, providers);
      }),
    read: (threadId, instanceId) =>
      Ref.get(sessions).pipe(
        Effect.map((current) => {
          const providers = current.get(threadId);
          return instanceId === undefined
            ? Array.from(providers?.values() ?? []).at(-1)
            : providers?.get(instanceId);
        }),
      ),
    clear: (threadId, credentialId) =>
      Ref.update(sessions, (current) => {
        const next = new Map(current);
        const providers = new Map(
          Array.from(current.get(threadId) ?? []).filter(
            ([, config]) => config.providerSessionId !== credentialId,
          ),
        );
        if (credentialId === undefined || providers.size === 0) next.delete(threadId);
        else next.set(threadId, providers);
        return next;
      }),
  });
});

export const layer = Layer.effect(McpProviderSessions, make);
