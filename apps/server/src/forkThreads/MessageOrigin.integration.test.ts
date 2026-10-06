import { expect, it } from "@effect/vitest";
import { EventId, MessageId, ThreadId, ProviderDriverKind } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeMessageOriginContext, readMessageOrigin } from "@t3tools/shared/messageOrigin";
import {
  projectComposerContextForProvider,
  collectComposerContextReferences,
} from "@t3tools/shared/composerContextReferences";
import { v2Projection } from "../../../../packages/client-runtime/src/state/orchestrationV2TestFixtures.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";

it.effect("persists origin once in V2 while excluding it from provider context and chips", () =>
  Effect.gen(function* () {
    const store = yield* ProjectionStore.ProjectionStoreV2;
    const now = DateTime.makeUnsafe("2026-10-05T00:00:00Z");
    const id = ThreadId.make("origin-root");
    const driver = ProviderDriverKind.make("codex");
    yield* store.apply({
      id: EventId.make("origin-created"),
      type: "thread.created",
      threadId: id,
      occurredAt: now,
      driver,
      payload: { ...v2Projection.thread, id, createdAt: now, updatedAt: now },
    });
    const context = makeMessageOriginContext({ source: "thread-send", fromThreadId: "child" });
    const event = {
      id: EventId.make("origin-message"),
      type: "message.updated" as const,
      threadId: id,
      occurredAt: now,
      driver,
      payload: {
        id: MessageId.make("origin-message"),
        threadId: id,
        runId: null,
        nodeId: null,
        role: "user" as const,
        text: "Check results",
        attachments: [],
        streaming: false,
        context,
        createdBy: "agent" as const,
        creationSource: "mcp" as const,
        createdAt: now,
        updatedAt: now,
      },
    };
    yield* store.apply(event);
    yield* store.apply(event);
    const projection = yield* store.getThreadProjection(id);
    expect(projection.messages).toHaveLength(1);
    expect(readMessageOrigin(projection.messages[0]!)).toEqual({
      source: "thread-send",
      fromThreadId: "child",
    });
    expect(
      projectComposerContextForProvider({ text: event.payload.text, records: context.records }),
    ).toBe("Check results");
    expect(collectComposerContextReferences(event.payload.text)).toEqual([]);
  }).pipe(Effect.provide(ProjectionStore.layer.pipe(Layer.provide(SqlitePersistenceMemory)))),
);
