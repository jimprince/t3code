import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  EventId,
  OrchestrationEvent,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type AutomationEventKind,
  type OrchestrationThreadShell,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { FetchHttpClient } from "effect/unstable/http";
import { expect } from "vite-plus/test";
import { ServerConfig } from "../config.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { AgentGateway, layer as gatewayLayer } from "./AgentGateway.ts";

const NOW = "2026-10-05T06:00:00.000Z";
const projectId = ProjectId.make("project");
const threadId = ThreadId.make("worker");
const decode = Schema.decodeUnknownSync(OrchestrationEvent);
const base = {
  aggregateKind: "thread",
  aggregateId: threadId,
  occurredAt: NOW,
  commandId: null,
  causationEventId: null,
  correlationId: null,
  metadata: {},
};
const shell = {
  id: threadId,
  projectId,
  title: "Worker",
} as OrchestrationThreadShell;

it.layer(NodeServices.layer)("automation gateway observations", (it) => {
  it.effect("maps orchestration events to observations only for wanted kinds", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const dir = yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped({
          prefix: "t3-automation-gateway-",
        });
        const events = yield* PubSub.unbounded<OrchestrationEvent>();
        const layer = gatewayLayer.pipe(
          Layer.provide(
            Layer.mergeAll(
              Layer.mock(OrchestrationEngineService)({
                subscribeDomainEvents: PubSub.subscribe(events).pipe(
                  Effect.map(Stream.fromSubscription),
                ),
              }),
              Layer.mock(ProjectionSnapshotQuery)({
                getThreadShellByIdIncludingArchived: () => Effect.succeed(Option.some(shell)),
              }),
              Layer.mock(ServerSettingsService)({
                getSettings: Effect.succeed(DEFAULT_SERVER_SETTINGS),
              }),
            ),
          ),
          Layer.provide(SqlitePersistenceMemory),
          Layer.provide(ServerConfig.layerTest(dir, { prefix: "t3-automation-gateway-" })),
          Layer.provide(FetchHttpClient.layer),
        );
        yield* Effect.gen(function* () {
          const gateway = yield* AgentGateway;
          const wanted = new Set<AutomationEventKind>(["worker.blocked"]);
          const stream = yield* gateway.observations(() => wanted);
          const seen = yield* Stream.take(stream, 2).pipe(Stream.runCollect, Effect.forkScoped);
          const publish = (event: unknown) => PubSub.publish(events, decode(event));
          yield* publish({
            ...base,
            sequence: 1,
            eventId: EventId.make("e1"),
            type: "thread.activity-appended",
            payload: {
              threadId,
              activity: {
                id: EventId.make("activity-1"),
                tone: "approval",
                kind: "approval.requested",
                summary: "Run tests?",
                payload: {},
                turnId: null,
                createdAt: NOW,
              },
            },
          });
          // A routine tool activity is not a blocked worker.
          yield* publish({
            ...base,
            sequence: 2,
            eventId: EventId.make("e2"),
            type: "thread.activity-appended",
            payload: {
              threadId,
              activity: {
                id: EventId.make("activity-2"),
                tone: "tool",
                kind: "tool.started",
                summary: "ls",
                payload: {},
                turnId: null,
                createdAt: NOW,
              },
            },
          });
          const session = (sequence: number, status: string) => ({
            ...base,
            sequence,
            eventId: EventId.make(`e${sequence}`),
            type: "thread.session-set",
            payload: {
              threadId,
              session: {
                threadId,
                status,
                providerName: "codex",
                providerInstanceId: ProviderInstanceId.make("codex"),
                runtimeMode: "full-access",
                activeTurnId: null,
                lastError: status === "error" ? "Provider crashed" : null,
                updatedAt: NOW,
              },
            },
          });
          yield* publish(session(3, "error"));
          const observed = [...(yield* Fiber.join(seen))];
          expect(observed).toEqual([
            {
              type: "thread-waiting",
              projectId,
              threadId,
              title: "Worker",
              reason: "approval",
              requestId: "activity-1",
              at: NOW,
            },
            {
              type: "thread-session",
              projectId,
              threadId,
              title: "Worker",
              status: "error",
              error: "Provider crashed",
              at: NOW,
            },
          ]);
        }).pipe(Effect.provide(layer));
      }),
    ),
  );
});
