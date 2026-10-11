import { describe, expect } from "vite-plus/test";
import { it } from "@effect/vitest";
import {
  type DashboardSnapshot,
  EnvironmentId,
  ThreadId,
  RuntimeRequestId,
  WS_METHODS,
  ProjectDashboardError,
  type OrchestrationV2ShellSnapshot,
  type ProjectIssuesListResult,
  type ProjectIssue,
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
import { EnvironmentRpcRequestObserver } from "../rpc/client.ts";
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
  threads: roots.map((id) => ({
    ...v2ThreadShell,
    id,
    title: id,
    pendingRuntimeRequest: {
      id: RuntimeRequestId.make(`ask-${id}`),
      kind: "user_input",
      createdAt: v2ThreadShell.createdAt,
    },
  })),
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
          [WS_METHODS.projectDashboardGet]: () =>
            Effect.fail(new ProjectDashboardError({ message: "Unsupported" })),
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
        const beforeReopen = calls.length;
        const reopened = yield* readOlderDashboard(shell, initial).pipe(
          Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
        );
        expect(calls.slice(beforeReopen)).toEqual(["metadata"]);
        expect(reopened.projects.flatMap((p) => p.tasks).map((t) => t.title)).toEqual([
          "Real task",
        ]);
        expect(reopened.sources.find((s) => s.id === "older:root:issues")?.failed).toBe(false);
        fail = true;
        yield* TestClock.adjust("5 minutes");
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
  [WS_METHODS.projectDashboardGet]: () =>
    Effect.fail(new ProjectDashboardError({ message: "Unsupported" })),
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
      yield* TestClock.adjust("60 seconds");
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
      yield* TestClock.adjust("15 seconds");
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
      threads: ids.map((id) => ({ ...shell.threads[0]!, id, title: id })),
    };
    const enriched = yield* Deferred.make<DashboardSnapshot>();
    const earlyStarted = yield* Deferred.make<void>();
    const lateStarted = yield* Deferred.make<void>();
    const client = {
      [WS_METHODS.projectDashboardGet]: () =>
        Effect.fail(new ProjectDashboardError({ message: "Unsupported" })),
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
    yield* TestClock.adjust("60 seconds");
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
    yield* TestClock.adjust("60 seconds");
    expect((yield* Fiber.join(fiber)).revision).toBe(3);
  }),
);

it.effect("queued reads get a full deadline after acquiring a permit", () =>
  Effect.gen(function* () {
    const ids = Array.from({ length: 4 }, (_, i) => ThreadId.make(`queued-${i}`));
    const queuedShell = {
      ...shell,
      threads: ids.map((id) => ({ ...shell.threads[0]!, id, title: id })),
    };
    const waves = yield* Effect.forEach([0, 1, 2], () => Deferred.make<void>());
    let started = 0;
    const delayed = <A>(value: A) =>
      Effect.gen(function* () {
        const wave = Math.floor(started++ / 4);
        yield* Deferred.succeed(waves[wave]!, undefined);
        yield* Effect.sleep("24 seconds");
        return value;
      });
    const client = {
      ...metadataClient,
      "fork.threads.metadata.list": () =>
        Effect.succeed(
          ids.map((threadId) => ({ threadId, parentThreadId: null, subproject: "on" })),
        ),
      [WS_METHODS.projectIssuesList]: () =>
        delayed({ issues: [], repositories: [], fetchedAt: "2026-10-11T10:00:00Z" }),
      [WS_METHODS.projectRoadmapGet]: () => delayed({ tracker: null, versions: [], items: [] }),
      [WS_METHODS.projectRequestsPendingAsks]: () => delayed({ asks: [] }),
    } as unknown as WsRpcProtocolClient;
    const fiber = yield* provideOlderClient(readOlderDashboard(queuedShell), client).pipe(
      Effect.forkChild,
    );
    for (const wave of waves) {
      yield* Deferred.await(wave);
      yield* TestClock.adjust("24 seconds");
    }
    const snapshot = yield* Fiber.join(fiber);
    expect(started).toBe(12);
    expect(
      snapshot.sources
        .filter((s) => s.id.startsWith("older:queued-"))
        .every((s) => !s.failed && s.coverage === "bounded"),
    ).toBe(true);
  }),
);

it.effect(
  "skips unlinked trackers and known-empty asks while retaining linked and pending roots",
  () =>
    Effect.gen(function* () {
      const calls: string[] = [];
      const observed: string[] = [];
      const noAsks = {
        ...shell,
        threads: shell.threads.map((t) => ({
          ...t,
          pendingRuntimeRequest: t.id === root ? null : t.pendingRuntimeRequest,
        })),
      };
      const client = {
        ...metadataClient,
        [WS_METHODS.projectDashboardGet]: ({ threadId }: { threadId: ThreadId }) =>
          Effect.succeed({ tracker: threadId === root ? null : "brad/repo" }),
        [WS_METHODS.projectIssuesList]: ({ rootThreadId }: { rootThreadId: ThreadId }) =>
          Effect.sync(() => {
            calls.push(`issues:${rootThreadId}`);
            return { issues: [], repositories: [], fetchedAt: "2026-10-11T10:00:00Z" };
          }),
        [WS_METHODS.projectRoadmapGet]: ({ threadId }: { threadId: ThreadId }) =>
          Effect.sync(() => {
            calls.push(`roadmap:${threadId}`);
            return { tracker: null, versions: [], items: [] };
          }),
        [WS_METHODS.projectRequestsPendingAsks]: ({ threadId }: { threadId: ThreadId }) =>
          Effect.sync(() => {
            calls.push(`asks:${threadId}`);
            return {
              asks: [
                {
                  threadId,
                  threadTitle: "Pending decision",
                  projectTitle: "Other",
                  requestId: RuntimeRequestId.make("ask-other"),
                  createdAt: "2026-10-11T10:00:00Z",
                  canRespond: true,
                  kind: "question",
                  messageResponse: true,
                  questions: [{ id: "q", header: "Decision", question: "Proceed?", options: [] }],
                },
              ],
            };
          }),
      } as unknown as WsRpcProtocolClient;
      const snapshot = yield* provideOlderClient(readOlderDashboard(noAsks), client).pipe(
        Effect.provideService(EnvironmentRpcRequestObserver, {
          observe: ({ method }) =>
            Effect.sync(() => {
              observed.push(method);
              return Effect.void;
            }),
        }),
      );
      expect(observed).toEqual([]);
      expect(snapshot.projects.flatMap((p) => p.attention).map((a) => a.question)).toEqual([
        "Proceed?",
      ]);
      expect(calls.toSorted()).toEqual(["asks:other", "issues:other", "roadmap:other"]);
      expect(
        snapshot.sources
          .filter((s) => s.id.startsWith("older:root:"))
          .every((s) => !s.failed && s.coverage === "complete"),
      ).toBe(true);
    }),
);

it.effect(
  "reads tracker decisions for a head with only remote workers even without a local tracker",
  () =>
    Effect.gen(function* () {
      const calls: ThreadId[] = [];
      const now = "2026-10-11T10:00:00Z";
      const issue: ProjectIssue = {
        host: "git.test",
        repository: "brad/cos",
        number: 462,
        title: "Choose an owner",
        url: "https://git.test/brad/cos/issues/462",
        status: "pending",
        labels: ["needs-brad"],
        isRequest: false,
        requestSource: null,
        assignees: [],
        comments: 0,
        createdAt: now,
        updatedAt: now,
        closedAt: null,
        linkedThreadIds: [],
        milestone: null,
        owner: { threadId: root, title: "Chief of Staff", projectTitle: "VM" },
        decision: { context: "Proceed?", waiting: root, options: [] },
      };
      const client = {
        "fork.threads.metadata.list": () =>
          Effect.succeed(
            roots.map((threadId) => ({
              threadId,
              parentThreadId: null,
            })),
          ),
        [WS_METHODS.projectDashboardGet]: () => Effect.succeed({ tracker: null }),
        [WS_METHODS.projectIssuesList]: ({ rootThreadId }: { rootThreadId: ThreadId }) =>
          Effect.sync(() => {
            calls.push(rootThreadId);
            return { issues: [issue], repositories: [], fetchedAt: now };
          }),
        [WS_METHODS.projectRoadmapGet]: () =>
          Effect.succeed({ tracker: null, versions: [], items: [] }),
        [WS_METHODS.projectRequestsPendingAsks]: () => Effect.succeed({ asks: [] }),
      } as unknown as WsRpcProtocolClient;
      const noAsks = {
        ...shell,
        threads: shell.threads.map((t) => ({ ...t, pendingRuntimeRequest: null })),
      };
      const snapshot = yield* provideOlderClient(
        readOlderDashboard(noAsks, undefined, undefined, undefined, [root]),
        client,
      );
      expect(calls).toEqual([root]);
      expect(snapshot.projects.map((p) => p.rootThreadId)).toEqual([root]);
      expect(snapshot.projects[0]?.attention).toContainEqual(
        expect.objectContaining({
          title: "Choose an owner",
          question: "Proceed?",
          threadId: root,
        }),
      );
    }),
);
