import { describe, expect } from "vite-plus/test";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import * as Deferred from "effect/Deferred";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import * as DateTime from "effect/DateTime";
import * as FileSystem from "effect/FileSystem";
import * as SqlClient from "effect/sql/SqlClient";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  ThreadId,
  RuntimeRequestId,
  type DashboardSnapshot,
  type OrchestrationV2DomainEvent,
} from "@t3tools/contracts";
import { v2ThreadShell } from "../../../../packages/client-runtime/src/state/orchestrationV2TestFixtures.ts";
import { layerMemory } from "../persistence/Sqlite.ts";
import { initializeMetadata, writeMetadata } from "../forkThreads/MetadataStore.ts";
import { insertRequest, insertQuestion, AT } from "../projectIssues/pendingAsks.testkit.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProjectIssuesService from "../projectIssues/ProjectIssuesService.ts";
import { PlanFileService } from "../orchestration-v2/PlanFileService.ts";
import * as DashboardStore from "./DashboardStore.ts";
import * as DashboardService from "./DashboardService.ts";

const root = ThreadId.make("root");
describe("answered runtime asks (#303)", () => {
  it.effect.each(["runtime-request.updated", "turn-item.updated"] as const)(
    "publishes immediately on %s without a tracker refresh or debounce",
    (type) =>
      Effect.scoped(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* initializeMetadata(sql);
          yield* writeMetadata(sql, { threadId: root, parentThreadId: null, subproject: "on" });
          yield* insertRequest(sql, { id: "ask", thread: root, status: "pending", at: AT });
          yield* insertQuestion(sql, root, "ask", 1);
          const events = yield* PubSub.unbounded<OrchestrationV2DomainEvent>();
          const subscribed = yield* Deferred.make<void>();
          const published = yield* Deferred.make<DashboardSnapshot>();
          let subscribers = 0;
          let answered = false;
          const stream = Stream.unwrap(
            Effect.gen(function* () {
              const queue = yield* PubSub.subscribe(events);
              subscribers++;
              if (subscribers === 2) yield* Deferred.succeed(subscribed, undefined);
              return Stream.fromSubscription(queue);
            }),
          );
          const shell = () => ({
            ...v2ThreadShell,
            id: root,
            title: "Dashboard",
            archivedAt: null,
            pendingRuntimeRequest: answered
              ? null
              : {
                  id: RuntimeRequestId.make("ask"),
                  kind: "user_input" as const,
                  createdAt: DateTime.makeUnsafe(AT),
                },
          });
          const run = Effect.gen(function* () {
            const dashboard = yield* DashboardService.make;
            yield* Deferred.await(subscribed);
            expect((yield* dashboard.getSnapshot).projects[0]?.attention).toHaveLength(1);
            // Move the test clock beyond the durable-write interval before delivering the event.
            yield* TestClock.adjust("61 seconds");
            answered = true;
            // The local read model is already updated when domain events are delivered.
            yield* sql.unsafe(
              "UPDATE orchestration_v2_projection_runtime_requests SET status = 'resolved'",
            );
            yield* PubSub.publish(events, {
              type,
              payload: {
                type: "user_input_request",
                questionAnswer: { answers: { heard: "Yes" } },
              },
            } as unknown as OrchestrationV2DomainEvent);
            const snapshot = yield* Deferred.await(published);
            expect(snapshot.projects[0]?.attention).toEqual([]);
            expect((yield* dashboard.getSnapshot).revision).toBe(snapshot.revision);
          }).pipe(
            Effect.provideService(ThreadManagement.ThreadManagementService, {
              getShellSnapshot: () =>
                Effect.succeed({ threads: [shell()], archivedThreads: [], projects: [] }),
              streamDomainEvents: stream,
            } as never),
            Effect.provideService(ProjectService.ProjectService, {
              listShells: () => Effect.succeed([]),
            } as never),
            Effect.provideService(ProjectIssuesService.Service, {
              list: () => Effect.die("Runtime answers must not wait for the tracker"),
            } as never),
            Effect.provideService(PlanFileService, { scan: Effect.succeed([]) } as never),
            Effect.provideService(FileSystem.FileSystem, {
              exists: () => Effect.succeed(false),
            } as never),
            Effect.provideService(DashboardStore.DashboardStore, {
              read: Effect.succeed(null),
              write: (value) =>
                answered
                  ? Deferred.succeed(published, value.snapshot).pipe(Effect.asVoid)
                  : Effect.void,
            }),
          );
          yield* run;
        }),
      ).pipe(Effect.provide(layerMemory.pipe(Layer.provideMerge(NodeServices.layer)))),
  );
});
