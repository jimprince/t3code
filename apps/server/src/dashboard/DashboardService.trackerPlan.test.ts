import { describe, expect } from "vite-plus/test";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ThreadId, type ProjectIssue } from "@t3tools/contracts";
import { v2ThreadShell } from "../../../../packages/client-runtime/src/state/orchestrationV2TestFixtures.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProjectIssuesService from "../projectIssues/ProjectIssuesService.ts";
import { PlanFileService } from "../orchestration-v2/PlanFileService.ts";
import { trackerPlan } from "../projectIssues/trackerPlan.logic.ts";
import * as DashboardStore from "./DashboardStore.ts";
import * as DashboardService from "./DashboardService.ts";

const a = ThreadId.make("root-a");
const b = ThreadId.make("root-b");
const at = "2026-10-14T00:00:00.000Z";
const row = (number: number): ProjectIssue => ({
  host: "git.test",
  repository: "brad/repo",
  number,
  title: `Task ${number}`,
  url: `https://git.test/brad/repo/issues/${number}`,
  labels: ["ask"],
  status: "pending",
  isRequest: true,
  requestSource: null,
  createdAt: at,
  updatedAt: at,
  closedAt: null,
  comments: 0,
  linkedThreadIds: [number === 1 ? a : b],
  assignees: [],
  plan: trackerPlan({
    body: "- [x] One\n- [ ] Two",
    closed: false,
    closedAt: null,
    stage: "requested",
  }),
});
const fallback = {
  rootThreadId: b,
  head: "b",
  title: "B",
  updated_utc: at,
  workstreams: [
    {
      id: "legacy",
      title: "Legacy",
      tasks: [
        {
          id: "legacy",
          title: "Legacy orphan",
          kind: "feature",
          link: "",
          steps_done: 1,
          steps_total: 5,
          eta_utc: null,
          next_step: "Legacy next",
          updated_utc: at,
        },
      ],
    },
  ],
};

describe("durable root-scoped tracker cutover (#297)", () => {
  it.effect(
    "requires explicit id, ignores flagged payload, retains tracker after failure and reload, and preserves genuine clocks",
    () =>
      Effect.gen(function* () {
        let stored: Effect.Success<DashboardStore.DashboardStore["Service"]["read"]> = null;
        let failed = false;
        let noteFailed = false;
        let missingTarget = false;
        let rows = [row(1), row(2)];
        let flaggedReads = 0;
        let reload = false;
        let missingRootId = true;
        let unboundLegacy = true;
        const shells = [a, b].map((id) => ({
          ...v2ThreadShell,
          id,
          title: id === a ? "A" : "B",
          archivedAt: null,
          todoProgress: null,
        }));
        const metadata = shells.map((t) => ({
          payload: JSON.stringify({ threadId: t.id, parentThreadId: null, subproject: "on" }),
        }));
        const fs = {
          exists: (path: string) => Effect.succeed(path.endsWith(".local/share/briefing/tasks")),
          readDirectory: () => Effect.succeed(["a.json", "b.json"]),
          readFileString: (path: string) =>
            Effect.sync(() => {
              if (path.endsWith("a.json")) {
                flaggedReads++;
                if (missingRootId) {
                  const { rootThreadId: _id, ...legacy } = fallback;
                  return JSON.stringify({ ...legacy, head: "a", title: "A", source: "tracker" });
                }
                return JSON.stringify({
                  head: "a",
                  title: "A",
                  rootThreadId: a,
                  source: "tracker",
                  updated_utc: at,
                  workstreams: "INVALID ignored payload",
                });
              }
              return JSON.stringify(
                unboundLegacy
                  ? { ...fallback, rootThreadId: undefined, title: "Renamed legacy head" }
                  : fallback,
              );
            }),
        } as never;
        const run = Effect.scoped(
          Effect.gen(function* () {
            const dashboard = yield* DashboardService.make;
            yield* dashboard.refresh;
            if (!reload) {
              const unbound = yield* dashboard.getSnapshot;
              expect(unbound.planMigration).toBeUndefined();
              expect(unbound.projects.find((p) => p.id === "head:b")?.tasks[0]?.title).toBe(
                "Legacy orphan",
              );
              expect(unbound.sources.find((s) => s.id === "plan:b")?.failed).toBe(false);
              unboundLegacy = false;
              expect(
                (yield* dashboard.getSnapshot).projects.find((p) => p.rootThreadId === a)
                  ?.planSource,
              ).toBe("briefing");
              missingRootId = false;
              yield* dashboard.refreshAfterWrite;
            }
            const initial = yield* dashboard.getSnapshot;
            expect(initial.projects).toHaveLength(2);
            if (reload) {
              expect(
                initial.projects.find((p) => p.rootThreadId === a)?.tasks[0]?.progress?.done,
              ).toBe(2);
              expect(
                initial.projects.find((p) => p.rootThreadId === a)?.tasks[0]?.progress
                  ?.confirmationKnown,
              ).toBe(true);
              expect(flaggedReads).toBe(2);
              return;
            }
            expect(
              initial.projects.find((p) => p.rootThreadId === a)?.tasks.map((t) => t.title),
            ).toEqual(["Task 1"]);
            expect(
              initial.projects
                .find((p) => p.rootThreadId === b)
                ?.tasks.some((t) => t.title === "Legacy orphan"),
            ).toBe(true);
            const confirmation = initial.projects.find((p) => p.rootThreadId === a)?.tasks[0]
              ?.progress?.confirmedAt;
            rows = rows.map((r) => ({
              ...r,
              title: `Edited ${r.number}`,
              rank: 99,
              updatedAt: "2026-10-14T01:00:00.000Z",
            }));
            yield* dashboard.refreshAfterWrite;
            expect(
              (yield* dashboard.getSnapshot).projects.find((p) => p.rootThreadId === a)?.tasks[0]
                ?.progress?.confirmedAt,
            ).toBe(confirmation);
            expect(flaggedReads).toBe(2);
            rows = rows.map((r) =>
              r.number === 1
                ? {
                    ...r,
                    plan: trackerPlan({
                      body: "- [x] One\n- [x] Two",
                      closed: false,
                      closedAt: null,
                      stage: "requested",
                    }),
                  }
                : r,
            );
            yield* dashboard.refreshAfterWrite;
            expect(
              (yield* dashboard.getSnapshot).projects.find((p) => p.rootThreadId === a)?.tasks[0]
                ?.progress?.confirmationKnown,
            ).toBe(true);
            noteFailed = true;
            yield* dashboard.refreshAfterWrite;
            const partialNotes = yield* dashboard.getSnapshot;
            expect(partialNotes.sources.find((s) => s.kind === "gitea")?.failed).toBe(false);
            expect(partialNotes.sources.find((s) => s.kind === "gitea")?.detail).toBe(
              "Progress notes unavailable",
            );
            noteFailed = false;
            missingTarget = true;
            yield* dashboard.refreshAfterWrite;
            expect(
              (yield* dashboard.getSnapshot).projects.find((p) => p.rootThreadId === a)?.tasks[0]
                ?.progress?.done,
            ).toBe(2);
            missingTarget = false;
            failed = true;
            yield* dashboard.refreshAfterWrite;
            const stale = yield* dashboard.getSnapshot;
            expect(stale.projects.find((p) => p.rootThreadId === a)?.tasks[0]?.progress?.done).toBe(
              2,
            );
            expect(stale.sources.find((s) => s.kind === "gitea")?.failed).toBe(true);
            expect(stored?.trackerRoots).toContain(a);
          }),
        ).pipe(
          Effect.provideService(FileSystem.FileSystem, fs),
          Effect.provideService(SqlClient.SqlClient, (() => Effect.succeed(metadata)) as never),
          Effect.provideService(ThreadManagement.ThreadManagementService, {
            getShellSnapshot: () =>
              Effect.succeed({ threads: shells, archivedThreads: [], projects: [] }),
            streamDomainEvents: Stream.never,
          } as never),
          Effect.provideService(ProjectService.ProjectService, {
            listShells: () => Effect.succeed([]),
          } as never),
          Effect.provideService(ProjectIssuesService.Service, {
            list: () =>
              Effect.succeed({
                primaryRepository: missingTarget
                  ? null
                  : { host: "git.test", repository: "brad/repo" },
                repositories: missingTarget
                  ? []
                  : [
                      {
                        host: "git.test",
                        repository: "brad/repo",
                        error: failed ? "Unavailable" : null,
                        noteCoverage: noteFailed ? "unavailable" : "complete",
                        noteError: noteFailed ? "Could not read tracker progress notes." : null,
                      },
                    ],
                issues: failed || missingTarget ? [] : rows,
                fetchedAt: at,
              }),
          } as never),
          Effect.provideService(PlanFileService, { scan: Effect.succeed([]) } as never),
          Effect.provideService(DashboardStore.DashboardStore, {
            read: Effect.sync(() => stored),
            write: (value) =>
              Effect.sync(() => {
                stored = value;
              }),
          }),
          Effect.provide(NodeServices.layer),
        );
        yield* run;
        reload = true;
        // Restart uses the last persisted root source and header, without a payload reread.
        yield* run;
        expect(flaggedReads).toBe(2);
      }),
  );
});
