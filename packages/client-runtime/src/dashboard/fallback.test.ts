import { describe, expect } from "vite-plus/test";
import { it } from "@effect/vitest";
import {
  EnvironmentId,
  ThreadId,
  WS_METHODS,
  type OrchestrationV2ShellSnapshot,
  type ProjectIssuesListResult,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
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
