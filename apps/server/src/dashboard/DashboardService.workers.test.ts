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
import { ThreadId, type OrchestrationV2DomainEvent, type ProjectIssue } from "@t3tools/contracts";
import { v2ThreadShell } from "../../../../packages/client-runtime/src/state/orchestrationV2TestFixtures.ts";
import { layerMemory } from "../persistence/Sqlite.ts";
import { initializeMetadata, writeMetadata } from "../forkThreads/MetadataStore.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProjectIssuesService from "../projectIssues/ProjectIssuesService.ts";
import { PlanFileService } from "../orchestration-v2/PlanFileService.ts";
import * as DashboardStore from "./DashboardStore.ts";
import * as DashboardService from "./DashboardService.ts";
import { emptySnapshot } from "./dashboard.logic.ts";

const head = ThreadId.make("head");
const worker = ThreadId.make("worker");
const at = "2026-10-16T09:00:00.000Z";
const issue: ProjectIssue = {
  host: "git.test",
  repository: "brad/repo",
  number: 364,
  title: "Show workers",
  url: "https://git.test/brad/repo/issues/364",
  labels: ["ask"],
  status: "in-progress",
  isRequest: true,
  requestSource: null,
  createdAt: at,
  updatedAt: at,
  closedAt: null,
  comments: 0,
  linkedThreadIds: [head, worker],
  assignees: [],
};

describe("threads working on a Plan row (#364)", () => {
  it.effect("republishes on run.updated from local shells, without a tracker read", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* initializeMetadata(sql);
        yield* writeMetadata(sql, { threadId: head, parentThreadId: null, subproject: "on" });
        yield* writeMetadata(sql, { threadId: worker, parentThreadId: head });
        const events = yield* PubSub.unbounded<OrchestrationV2DomainEvent>();
        const subscribed = yield* Deferred.make<void>();
        let subscribers = 0;
        const stream = Stream.unwrap(
          Effect.gen(function* () {
            const queue = yield* PubSub.subscribe(events);
            subscribers++;
            if (subscribers === 2) yield* Deferred.succeed(subscribed, undefined);
            return Stream.fromSubscription(queue);
          }),
        );
        let workerStatus: "idle" | "running" = "idle";
        const shell = (id: ThreadId) => ({
          ...v2ThreadShell,
          id,
          title: id === head ? "Head" : "Builder",
          archivedAt: null,
          status: id === head ? ("running" as const) : workerStatus,
          activityRunStartedAt: DateTime.makeUnsafe(at),
        });
        yield* Effect.gen(function* () {
          const dashboard = yield* DashboardService.make;
          yield* Deferred.await(subscribed);
          const tasks = () =>
            dashboard.getSnapshot.pipe(Effect.map((s) => s.projects[0]?.tasks ?? []));
          expect(yield* tasks()).toHaveLength(1);
          expect((yield* tasks())[0]?.workers).toBeUndefined();
          const revision = (yield* dashboard.getSnapshot).revision;
          workerStatus = "running";
          // The local read model is already updated when domain events are delivered.
          yield* PubSub.publish(events, { type: "run.updated" } as OrchestrationV2DomainEvent);
          yield* TestClock.adjust("74 millis");
          expect((yield* tasks())[0]?.workers).toBeUndefined();
          yield* TestClock.adjust("1 millis");
          expect((yield* tasks())[0]?.workers).toEqual([
            { threadId: worker, title: "Builder", state: "running", startedAt: at },
          ]);
          expect((yield* dashboard.getSnapshot).revision).toBe(revision + 1);
        }).pipe(
          Effect.provideService(ThreadManagement.ThreadManagementService, {
            getShellSnapshot: () =>
              Effect.succeed({
                threads: [shell(head), shell(worker)],
                archivedThreads: [],
                projects: [],
              }),
            streamDomainEvents: stream,
          } as never),
          Effect.provideService(ProjectService.ProjectService, {
            listShells: () => Effect.succeed([]),
          } as never),
          Effect.provideService(ProjectIssuesService.Service, {
            list: () => Effect.die("A run change must not wait for the tracker"),
          } as never),
          Effect.provideService(PlanFileService, { scan: Effect.succeed([]) } as never),
          Effect.provideService(FileSystem.FileSystem, {
            exists: () => Effect.succeed(false),
          } as never),
          Effect.provideService(DashboardStore.DashboardStore, {
            read: Effect.succeed({
              snapshot: emptySnapshot(at),
              samples: [],
              issues: { [head]: [issue] },
            }),
            write: () => Effect.void,
          }),
        );
      }),
    ).pipe(Effect.provide(layerMemory.pipe(Layer.provideMerge(NodeServices.layer)))),
  );
});
