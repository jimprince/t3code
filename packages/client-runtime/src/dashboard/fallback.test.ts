import { describe, expect } from "vite-plus/test";
import { it } from "@effect/vitest";
import {
  type DashboardSnapshot,
  EnvironmentId,
  ThreadId,
  WS_METHODS,
  type OrchestrationV2ShellSnapshot,
  type ProjectIssuesListResult,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import * as Option from "effect/Option";
import * as SubscriptionRef from "effect/SubscriptionRef";
import {
  AVAILABLE_CONNECTION_STATE,
  PrimaryConnectionTarget,
  type PreparedConnection,
} from "../connection/model.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import type { WsRpcProtocolClient } from "../rpc/protocol.ts";
import type { RpcSession } from "../rpc/session.ts";
import { v2ThreadShell } from "../state/orchestrationV2TestFixtures.ts";
import { readOlderDashboard } from "./fallback.ts";
const root = ThreadId.make("root");
const roots = [root, ThreadId.make("other")];
const shell: OrchestrationV2ShellSnapshot = {
  schemaVersion: 1,
  snapshotSequence: 1,
  projects: [],
  archivedThreads: [],
  threads: roots.map((id) => ({ ...v2ThreadShell, id, title: id })),
};
const target = new PrimaryConnectionTarget({
  environmentId: EnvironmentId.make("old"),
  label: "Older host",
  httpBaseUrl: "https://old.test",
  wsBaseUrl: "wss://old.test",
});

describe("older-server RPC composition", () => {
  it.effect(
    "reads each root once in a globally bounded pass and preserves failed repository rows",
    () =>
      Effect.gen(function* () {
        let active = 0;
        let maximum = 0;
        let fail = false;
        const calls: string[] = [];
        const read = <A>(name: string, value: A) =>
          Effect.gen(function* () {
            calls.push(name);
            active++;
            maximum = Math.max(maximum, active);
            yield* Effect.yieldNow;
            active--;
            return value;
          });
        const now = "2026-10-11T10:00:00Z";
        const issues = (id: ThreadId): ProjectIssuesListResult => ({
          fetchedAt: now,
          repositories: [
            { host: "git.test", repository: "brad/repo", error: fail ? "unreachable" : null },
          ],
          issues: fail
            ? []
            : [
                {
                  host: "git.test",
                  repository: "brad/repo",
                  number: 1,
                  title: "Real task",
                  url: "https://git.test/brad/repo/issues/1",
                  status: "pending",
                  labels: [],
                  isRequest: false,
                  requestSource: null,
                  assignees: [],
                  comments: 0,
                  createdAt: now,
                  updatedAt: now,
                  closedAt: null,
                  linkedThreadIds: [id],
                },
              ],
        });
        const client = {
          "fork.threads.metadata.list": () =>
            read(
              "metadata",
              roots.map((threadId) => ({ threadId, parentThreadId: null, subproject: "on" })),
            ),
          [WS_METHODS.projectIssuesList]: (input: { rootThreadId: ThreadId }) =>
            read(`issues:${input.rootThreadId}`, issues(input.rootThreadId)),
          [WS_METHODS.projectRoadmapGet]: (input: { threadId: ThreadId }) =>
            read(`roadmap:${input.threadId}`, { tracker: null, versions: [], items: [] }),
          [WS_METHODS.projectRequestsPendingAsks]: (input: { threadId: ThreadId }) =>
            read(`asks:${input.threadId}`, { asks: [] }),
        } as unknown as WsRpcProtocolClient;
        const session: RpcSession = {
          client,
          initialConfig: Effect.never,
          subscribeServerConfig: (input) => client.subscribeServerConfig(input),
          ready: Effect.void,
          probe: Effect.void,
          closed: Effect.never,
        };
        const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
          target,
          state: yield* SubscriptionRef.make(AVAILABLE_CONNECTION_STATE),
          session: yield* SubscriptionRef.make(Option.some(session)),
          prepared: yield* SubscriptionRef.make<Option.Option<PreparedConnection>>(Option.none()),
          connect: Effect.void,
          disconnect: Effect.void,
          retryNow: Effect.void,
        });
        const initial = yield* readOlderDashboard(shell, undefined, {
          version: "0.0.46-nightly.20261005.2689-fork.12",
          label: "Older host",
        }).pipe(Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor));
        expect(calls).toHaveLength(7);
        expect(new Set(calls).size).toBe(7);
        expect(maximum).toBeLessThanOrEqual(4);
        expect(initial.projects.flatMap((p) => p.tasks)).toHaveLength(1);
        expect(initial.sources.find((s) => s.id === "local")?.detail).toBe(
          "older server, live movement unavailable",
        );
        expect(initial.releases[0]).toMatchObject({
          title: "Older host",
          installedVersion: "0.0.46-nightly.20261005.2689-fork.12",
          latestVersion: null,
        });
        fail = true;
        const failed = yield* readOlderDashboard(shell, initial).pipe(
          Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
        );
        expect(failed.projects.flatMap((p) => p.tasks).map((t) => t.title)).toEqual(["Real task"]);
        expect(failed.sources.find((s) => s.id === "gitea:git.test/brad/repo")).toMatchObject({
          failed: true,
          lastSuccessAt: now,
        });
        expect(failed.projects.flatMap((p) => p.tasks)[0]?.movement.state).toBe("unknown");
      }),
  );
});

const provideOlderClient = <A, E, R>(effect: Effect.Effect<A, E, R>, client: WsRpcProtocolClient) =>
  Effect.gen(function* () {
    const session: RpcSession = {
      client,
      initialConfig: Effect.never,
      subscribeServerConfig: (input) => client.subscribeServerConfig(input),
      ready: Effect.void,
      probe: Effect.void,
      closed: Effect.never,
    };
    const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
      target,
      state: yield* SubscriptionRef.make(AVAILABLE_CONNECTION_STATE),
      session: yield* SubscriptionRef.make(Option.some(session)),
      prepared: yield* SubscriptionRef.make<Option.Option<PreparedConnection>>(Option.none()),
      connect: Effect.void,
      disconnect: Effect.void,
      retryNow: Effect.void,
    });
    return yield* effect.pipe(
      Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
    );
  });

const metadataClient = {
  "fork.threads.metadata.list": () =>
    Effect.succeed(roots.map((threadId) => ({ threadId, parentThreadId: null, subproject: "on" }))),
};

describe("older-server first revision", () => {
  it.effect(
    "publishes both heads and the reported release before any optional root read settles",
    () =>
      Effect.gen(function* () {
        const core = yield* Deferred.make<DashboardSnapshot>();
        const release = yield* Deferred.make<void>();
        const readStarted = yield* Deferred.make<void>();
        const wait = <A>(value: A) =>
          Deferred.succeed(readStarted, undefined).pipe(
            Effect.andThen(Deferred.await(release)),
            Effect.as(value),
          );
        const client = {
          ...metadataClient,
          [WS_METHODS.projectIssuesList]: () =>
            wait({ issues: [], repositories: [], fetchedAt: "2026-10-11T10:00:00Z" }),
          [WS_METHODS.projectRoadmapGet]: () => wait({ tracker: null, versions: [], items: [] }),
          [WS_METHODS.projectRequestsPendingAsks]: () => wait({ asks: [] }),
        } as unknown as WsRpcProtocolClient;
        const fiber = yield* provideOlderClient(
          readOlderDashboard(shell, undefined, { version: "fork.12", label: "VM" }, (snapshot) =>
            Deferred.succeed(core, snapshot).pipe(Effect.asVoid),
          ),
          client,
        ).pipe(Effect.forkChild);
        const snapshot = yield* Deferred.await(core);
        yield* Deferred.await(readStarted);
        expect(snapshot.revision).toBe(1);
        expect(snapshot.projects.map((p) => p.title).toSorted()).toEqual(["other", "root"]);
        expect(snapshot.releases[0]?.installedVersion).toBe("fork.12");
        expect(snapshot.sources.find((s) => s.id === "older:root:issues")).toMatchObject({
          coverage: "unavailable",
          failed: false,
          detail: "Read pending",
        });
        yield* Deferred.succeed(release, undefined);
        const settled = yield* Fiber.join(fiber);
        expect(settled.revision).toBe(2);
        expect(settled.sources.find((s) => s.id === "older:root:issues")).toMatchObject({
          coverage: "bounded",
          failed: false,
        });
      }),
  );
  it.effect("times out a hung root RPC and keeps successful sources and heads", () =>
    Effect.gen(function* () {
      const core = yield* Deferred.make<DashboardSnapshot>();
      const started = yield* Deferred.make<void>();
      const client = {
        ...metadataClient,
        [WS_METHODS.projectIssuesList]: () =>
          Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
        [WS_METHODS.projectRoadmapGet]: () =>
          Effect.succeed({ tracker: null, versions: [], items: [] }),
        [WS_METHODS.projectRequestsPendingAsks]: () => Effect.succeed({ asks: [] }),
      } as unknown as WsRpcProtocolClient;
      const fiber = yield* provideOlderClient(
        readOlderDashboard(shell, undefined, undefined, (snapshot) =>
          Deferred.succeed(core, snapshot).pipe(Effect.asVoid),
        ),
        client,
      ).pipe(Effect.forkChild);
      yield* Deferred.await(core);
      yield* Deferred.await(started);
      yield* TestClock.adjust("5 seconds");
      const settled = yield* Fiber.join(fiber);
      expect(settled.revision).toBe(2);
      expect(settled.projects).toHaveLength(2);
      expect(settled.sources.find((s) => s.id === "older:root:issues")).toMatchObject({
        coverage: "unavailable",
        failed: true,
        detail: "Read failed or timed out",
      });
      expect(settled.sources.find((s) => s.id === "older:root:roadmap")?.coverage).toBe("bounded");
    }),
  );
  it.effect("bounds metadata and preserves the previous heads when metadata never responds", () =>
    Effect.gen(function* () {
      const previous = yield* provideOlderClient(
        readOlderDashboard({ ...shell, threads: [] }),
        metadataClient as unknown as WsRpcProtocolClient,
      );
      const baseline = {
        ...previous,
        projects: [
          {
            id: "project:root",
            rootThreadId: root,
            parentId: null,
            title: "VM head",
            utility: false,
            tasks: [],
            attention: [],
            workstreams: [],
            sourceIds: ["local"],
            omittedTaskCount: 0,
          },
        ],
      };
      const started = yield* Deferred.make<void>();
      const client = {
        "fork.threads.metadata.list": () =>
          Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
      } as unknown as WsRpcProtocolClient;
      const fiber = yield* provideOlderClient(readOlderDashboard(shell, baseline), client).pipe(
        Effect.forkChild,
      );
      yield* Deferred.await(started);
      yield* TestClock.adjust("5 seconds");
      const settled = yield* Fiber.join(fiber);
      expect(settled.revision).toBe(baseline.revision + 1);
      expect(settled.projects[0]?.title).toBe("VM head");
      expect(settled.sources.find((s) => s.id === "older:metadata")).toMatchObject({
        coverage: "unavailable",
        failed: true,
      });
    }),
  );
});

it.effect("publishes expired sources before the rest of a large environment completes", () =>
  Effect.gen(function* () {
    const ids = Array.from({ length: 5 }, (_, i) => ThreadId.make(`head-${i}`));
    const largeShell = {
      ...shell,
      threads: ids.map((id) => ({ ...v2ThreadShell, id, title: id })),
    };
    const enriched = yield* Deferred.make<DashboardSnapshot>();
    const earlyStarted = yield* Deferred.make<void>();
    const lateStarted = yield* Deferred.make<void>();
    const client = {
      "fork.threads.metadata.list": () =>
        Effect.succeed(
          ids.map((threadId) => ({ threadId, parentThreadId: null, subproject: "on" })),
        ),
      [WS_METHODS.projectIssuesList]: ({ rootThreadId }: { rootThreadId: ThreadId }) =>
        rootThreadId === ids[0]
          ? Deferred.succeed(earlyStarted, undefined).pipe(Effect.andThen(Effect.never))
          : rootThreadId === ids[4]
            ? Deferred.succeed(lateStarted, undefined).pipe(Effect.andThen(Effect.never))
            : Effect.succeed({ issues: [], repositories: [], fetchedAt: "2026-10-11T10:00:00Z" }),
      [WS_METHODS.projectRoadmapGet]: () =>
        Effect.succeed({ tracker: null, versions: [], items: [] }),
      [WS_METHODS.projectRequestsPendingAsks]: () => Effect.succeed({ asks: [] }),
    } as unknown as WsRpcProtocolClient;
    const fiber = yield* provideOlderClient(
      readOlderDashboard(largeShell, undefined, undefined, (snapshot) =>
        snapshot.revision === 2
          ? Deferred.succeed(enriched, snapshot).pipe(Effect.asVoid)
          : Effect.void,
      ),
      client,
    ).pipe(Effect.forkChild);
    yield* Deferred.await(earlyStarted);
    yield* TestClock.adjust("5 seconds");
    const partial = yield* Deferred.await(enriched);
    yield* Deferred.await(lateStarted);
    expect(partial.projects).toHaveLength(5);
    expect(partial.sources.find((s) => s.id === "older:head-0:issues")).toMatchObject({
      failed: true,
      coverage: "unavailable",
    });
    expect(partial.sources.find((s) => s.id === "older:head-1:issues")?.coverage).toBe("bounded");
    expect(partial.sources.find((s) => s.id === "older:head-4:issues")).toMatchObject({
      failed: false,
      detail: "Read pending",
    });
    yield* TestClock.adjust("5 seconds");
    expect((yield* Fiber.join(fiber)).revision).toBe(3);
  }),
);
