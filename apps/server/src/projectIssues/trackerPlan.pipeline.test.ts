import { describe, expect } from "vite-plus/test";
import { it } from "@effect/vitest";
import * as TestClock from "effect/testing/TestClock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as SqlClient from "effect/sql/SqlClient";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Optional read-only fixture harness runs outside the live server.
import * as NodeFS from "node:fs";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Optional fixture directory comes from the explicit verification command.
import * as NodePath from "node:path";
import {
  DashboardSnapshot,
  EnvironmentId,
  ThreadId,
  type GiteaInstanceConfig,
} from "@t3tools/contracts";
import { aggregate, briefingPlanRoot } from "@t3tools/client-runtime/dashboard/aggregation";
import { compactSnapshot } from "@t3tools/client-runtime/dashboard/progress";
import { mergeDashboardSnapshots } from "@t3tools/client-runtime/dashboard/merge";
import { ServerConfig } from "../config.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import { v2ThreadShell } from "../../../../packages/client-runtime/src/state/orchestrationV2TestFixtures.ts";
import { confirmTrackerPlan } from "./trackerPlan.logic.ts";
import * as ProjectIssuesService from "./ProjectIssuesService.ts";

const encodeSnapshot = Schema.encodeEffect(Schema.fromJsonString(DashboardSnapshot));
const decodeSnapshot = Schema.decodeUnknownEffect(Schema.fromJsonString(DashboardSnapshot));
const now = "2026-10-14T10:00:00.000Z";
const root = ThreadId.make("pipeline-root");
const instance: GiteaInstanceConfig = {
  id: "test",
  host: "git.test",
  sshAliases: [],
  sshPorts: [],
  webOrigin: "https://git.test",
  apiOrigin: "https://git.test",
  token: "fixture",
};
const rawIssue = (number: number, body = "", labels = ["ask", "ask:task"]) => ({
  number,
  title: `Issue ${number}`,
  body,
  state: "open",
  html_url: `https://git.test/brad/repo/issues/${number}`,
  labels: labels.map((name) => ({ name })),
  created_at: now,
  updated_at: now,
});
type RawIssue = ReturnType<typeof rawIssue> & {
  closed_at?: string | null;
  due_date?: string | null;
};
const runPipeline = (
  issues: RawIssue[],
  comments: unknown[],
  repository = "brad/repo",
  bounded = false,
  failNotes = false,
  notesFailOnSecond = false,
  beforeSecondRead?: () => void,
  restart = false,
  concurrent = false,
  afterFirstNotes?: () => Effect.Effect<void>,
  rotateToken = false,
) =>
  Effect.gen(function* () {
    if ((yield* DateTime.now).epochMilliseconds === 0) yield* TestClock.setTime(Date.parse(now));
    const observedAt = DateTime.formatIso(yield* DateTime.now);
    const calls: string[] = [];
    let firstReadComplete = false;
    let firstNotesRead = false;
    const project = {
      id: "project",
      workspaceRoot: "/fixture",
      repositoryIdentity: {
        provider: "gitea",
        canonicalKey: `git.test/${repository}`,
        locator: { remoteUrl: `https://git.test/${repository}.git` },
      },
    };
    const thread = {
      ...v2ThreadShell,
      id: root,
      title: "Fixture root",
      projectId: "project",
      archivedAt: null,
      issues: [],
    };
    const result = yield* ProjectIssuesService.make.pipe(
      Effect.flatMap((service) =>
        Effect.gen(function* () {
          const reads = yield* Effect.all(
            Array.from({ length: concurrent ? 2 : 1 }, () =>
              service.list({ rootThreadId: root }, { complete: !bounded, closedHistory: !bounded }),
            ),
            { concurrency: "unbounded" },
          );
          const result = reads[0]!;
          const callsAfterFirst = calls.length;
          if (notesFailOnSecond || beforeSecondRead || rotateToken)
            service.invalidate({ host: "git.test", repository });
          if (rotateToken) {
            const settings = yield* ServerSettingsService;
            yield* settings.setGiteaToken(
              Redacted.make({ instanceId: instance.id, token: "rotated-fixture" }),
            );
          }
          beforeSecondRead?.();
          firstReadComplete = true;
          const nextService = restart ? yield* ProjectIssuesService.make : service;
          const cached = yield* nextService.list({ rootThreadId: root });
          return { result, cached, callsAfterFirst };
        }),
      ),
      Effect.provideService(SqlClient.SqlClient, ((_strings: TemplateStringsArray) =>
        Effect.succeed([])) as never),
      Effect.provideService(ProjectService.ProjectService, {
        listShells: () => Effect.succeed([project]),
        getShell: () => Effect.succeed(Option.some(project)),
      } as never),
      Effect.provideService(ThreadManagement.ThreadManagementService, {
        getShellSnapshot: () => Effect.succeed({ threads: [thread], archivedThreads: [] }),
        getThreadShell: () => Effect.succeed(thread),
      } as never),
      Effect.provideService(
        HttpClient.HttpClient,
        HttpClient.make((request) => {
          calls.push(request.url);
          const url = new URL(request.url);
          const page = Number(url.searchParams.get("page") ?? 1);
          const isComments = url.pathname.endsWith("/comments");
          if (
            rotateToken &&
            firstReadComplete &&
            request.headers.authorization !== "token rotated-fixture"
          )
            return Effect.succeed(
              HttpClientResponse.fromWeb(request, new Response("Revoked", { status: 401 })),
            );
          if (isComments && (failNotes || (notesFailOnSecond && firstReadComplete)))
            return Effect.succeed(
              HttpClientResponse.fromWeb(request, new Response("Unavailable", { status: 503 })),
            );
          const rows = isComments
            ? comments.filter((comment) => {
                const row = comment as { updated_at?: string; created_at: string };
                return (
                  !url.searchParams.get("since") ||
                  Date.parse(row.updated_at ?? row.created_at) >=
                    Date.parse(url.searchParams.get("since")!)
                );
              })
            : issues.filter(
                (issue) =>
                  issue.state === url.searchParams.get("state") &&
                  (!url.searchParams.get("since") ||
                    Date.parse(issue.updated_at) >= Date.parse(url.searchParams.get("since")!)),
              );
          return Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              new Response(JSON.stringify(rows.slice((page - 1) * 50, page * 50))),
            ),
          ).pipe(
            Effect.tap(() => {
              if (isComments && !firstNotesRead && afterFirstNotes) {
                firstNotesRead = true;
                return afterFirstNotes();
              }
              return isComments ? Effect.yieldNow : Effect.void;
            }),
          );
        }),
      ),
      Effect.provide(
        Layer.mergeAll(
          ServerSettingsService.layerTest({ giteaInstances: [instance] }),
          ServerConfig.layerTest(process.cwd(), { prefix: "tracker-pipeline-" }).pipe(
            Layer.provideMerge(NodeServices.layer),
          ),
        ),
      ),
    );
    const snapshot = aggregate({
      shells: [thread],
      metadata: [{ threadId: root, parentThreadId: null, subproject: "on" }],
      issues: new Map([[root, result.result.issues]]),
      sources: [],
      plans: [],
      samples: [],
      trackerRoots: new Set([root]),
      now: observedAt,
    });
    const wire = yield* encodeSnapshot(snapshot);
    const decoded = yield* decodeSnapshot(wire);
    const merged = mergeDashboardSnapshots([
      { environmentId: EnvironmentId.make("fixture"), snapshot: decoded },
    ]);
    return { ...result, snapshot: decoded, merged, calls };
  });

describe("raw tracker to shared merged Plan (#297)", () => {
  it.effect(
    "finds notes past page 50, keeps stage-only next null and caches once per repository",
    () =>
      Effect.gen(function* () {
        const comments = Array.from({ length: 51 }, (_, i) => ({
          id: i + 1,
          issue_url: "https://git.test/brad/repo/issues/1",
          created_at: now,
          body: i === 50 ? "Progress: started; next: Deploy 09:30Z" : "Discussion",
        }));
        const result = yield* runPipeline(
          [{ ...rawIssue(1, "- [x] One\n- [ ] Two"), due_date: "2026-10-20T00:00:00Z" }],
          comments,
        );
        expect(result.result.repositories[0]).toMatchObject({
          noteCoverage: "complete",
          noteError: null,
        });
        expect(result.merged.projects[0]?.project.tasks[0]).toMatchObject({
          progress: { done: 1, total: 2 },
          nextStep: "Deploy 09:30Z",
          forecast: { eta: "2026-10-20" },
        });
        expect(result.calls.filter((url) => url.includes("/issues/comments"))).toHaveLength(2);
        expect(result.calls.some((url) => /\/issues\/\d+/.test(url))).toBe(false);
      }),
  );
  it.effect("reports a bounded note budget rather than asserting complete latest coverage", () =>
    Effect.gen(function* () {
      const comments = Array.from({ length: 2001 }, (_, i) => ({
        id: i + 1,
        issue_url: "https://git.test/brad/repo/issues/1",
        created_at: now,
        body:
          i === 2000
            ? "Progress: next: Beyond budget"
            : i === 0
              ? "Progress: next: Older action"
              : "Discussion",
      }));
      const result = yield* runPipeline([rawIssue(1)], comments, "brad/repo", true);
      expect(result.result.repositories[0]?.noteCoverage).toBe("bounded");
      expect(result.result.issues[0]?.plan?.nextStep).toBeNull();
      expect(result.calls.filter((url) => url.includes("/issues/comments"))).toHaveLength(40);
      expect(result.calls.length).toBe(result.callsAfterFirst);
    }),
  );
  it.effect("keeps task body steps when repository notes fail and exposes the failure", () =>
    Effect.gen(function* () {
      const result = yield* runPipeline([rawIssue(1, "- [ ] Next")], [], "brad/repo", true, true);
      expect(result.result.repositories[0]).toMatchObject({
        noteCoverage: "unavailable",
        noteError: "Could not read tracker progress notes.",
      });
      expect(result.result.issues[0]?.plan).toMatchObject({ nextStep: "Next", total: 1 });
    }),
  );
});

it.effect("retains the last repository notes when a forced refresh fails", () =>
  Effect.gen(function* () {
    const comments = [
      {
        id: 1,
        issue_url: "https://git.test/brad/repo/issues/1",
        created_at: now,
        body: "Progress: next: Keep action",
      },
    ];
    const result = yield* runPipeline([rawIssue(1)], comments, "brad/repo", true, false, true);
    expect(result.cached.repositories[0]?.noteError).toBe("Could not read tracker progress notes.");
    expect(result.cached.issues[0]?.plan).toMatchObject({
      nextStep: "Keep action",
      confirmedAt: now,
    });
  }),
);

it.effect("confirms a legacy non-ask stage change without changing recorded steps", () =>
  Effect.gen(function* () {
    const issue = rawIssue(1, "- [ ] One", ["needs-review"]);
    const result = yield* runPipeline([issue], [], "brad/repo", true, false, false, () => {
      issue.labels = [{ name: "in-progress" }];
    });
    const before = result.result.issues[0]!.plan!;
    const after = result.cached.issues[0]!.plan!;
    expect(before.confirmedAt).toBeNull();
    expect(after.planVersion).toBe(before.planVersion);
    expect(confirmTrackerPlan(after, before, result.cached.fetchedAt).confirmedAt).toBe(
      result.cached.fetchedAt,
    );
  }),
);

const fixtureDirectory = process.env.REAL_TRACKER_FIXTURES;
if (fixtureDirectory)
  it.effect(
    "verifies freshly captured real repository responses through production projection and wire merge",
    () =>
      Effect.gen(function* () {
        const manifest = JSON.parse(
          NodeFS.readFileSync(NodePath.join(fixtureDirectory, "manifest.json"), "utf8"),
        ) as { startedAt: string };
        yield* TestClock.setTime(Date.parse(manifest.startedAt));
        const evidence: Record<string, unknown> = { capturedAt: manifest.startedAt };
        for (const repository of ["brad/t3code-fork", "brad/local-controller"]) {
          const prefix = repository.replace("/", "-");
          const issues = JSON.parse(
            NodeFS.readFileSync(NodePath.join(fixtureDirectory, `${prefix}-issues.json`), "utf8"),
          ) as RawIssue[];
          const comments = JSON.parse(
            NodeFS.readFileSync(NodePath.join(fixtureDirectory, `${prefix}-comments.json`), "utf8"),
          ) as unknown[];
          const result = yield* runPipeline(issues, comments, repository);
          const project = result.merged.projects[0]!.project;
          const numbers = repository.endsWith("t3code-fork")
            ? [109, 153, 155, 167, 171, 271, 74]
            : [172];
          const headers = numbers.map((number) => {
            const raw = result.result.issues.find((issue) => issue.number === number)!;
            expect(raw.epic).toBeDefined();
            expect(project.workstreams.find((w) => w.id.endsWith(`#${number}`))).toBeDefined();
            return { number, ...raw.epic };
          });
          if (repository.endsWith("t3code-fork")) {
            expect(result.result.issues.find((issue) => issue.number === 223)?.plan).toMatchObject({
              done: 1,
              total: 13,
            });
            expect(result.result.issues.find((issue) => issue.number === 255)?.plan).toMatchObject({
              done: 0,
              total: 4,
            });
            const expectedChildren = {
              109: [127, 128, 129, 130, 131, 132],
              153: [156, 157, 158, 159, 306],
              155: [
                145, 149, 151, 147, 148, 153, 193, 190, 184, 183, 179, 170, 165, 114, 171, 226, 242,
                258, 294, 319,
              ],
              167: [188, 187, 186, 185, 182, 178, 175, 173, 172],
              171: [210, 192, 180, 174, 169, 166],
              271: [308, 309],
              74: [189],
            };
            for (const [number, children] of Object.entries(expectedChildren))
              expect(
                result.result.issues
                  .find((issue) => issue.number === Number(number))
                  ?.epic?.children?.toSorted((a, b) => a - b),
              ).toEqual(children.toSorted((a, b) => a - b));
            const expected = {
              109: [6, 6],
              153: [4, 5],
              155: [10, 20],
              167: [8, 9],
              171: [5, 6],
              271: [0, 2],
              74: [0, 1],
            };
            for (const [number, counts] of Object.entries(expected))
              expect(
                result.result.issues.find((issue) => issue.number === Number(number))?.epic,
              ).toMatchObject({ done: counts[0], total: counts[1] });
          } else expect(headers[0]).toMatchObject({ done: 0, total: 0 });
          if (repository.endsWith("t3code-fork")) {
            const liveRoots = JSON.parse(
              NodeFS.readFileSync(NodePath.join(fixtureDirectory, "live-roots.json"), "utf8"),
            ) as Array<{
              threadId: string;
              title: string;
              organization: { parentThreadId: string | null; subproject?: "on" | "off" | "auto" };
            }>;
            const shells = liveRoots.map((root) => ({
              ...v2ThreadShell,
              id: ThreadId.make(root.threadId),
              title: root.title,
              archivedAt: null,
              todoProgress: null,
            }));
            const metadata = liveRoots.map((root) => ({
              threadId: ThreadId.make(root.threadId),
              parentThreadId: root.organization.parentThreadId
                ? ThreadId.make(root.organization.parentThreadId)
                : null,
              subproject: root.organization.subproject ?? "auto",
            }));
            const ids = shells.map((root) => root.id);
            const realRootSnapshot = aggregate({
              shells,
              metadata,
              issues: new Map(ids.map((id) => [id, result.result.issues])),
              trackerRoots: new Set(ids),
              rootRepositories: new Map(ids.map((id) => [id, `git.test/${repository}`])),
              plans: [],
              sources: [],
              samples: [],
              now,
            });
            const t3 = realRootSnapshot.projects.find(
              (p) => p.rootThreadId === "0db3169b-9f2e-4bf8-8f5e-c2b26be1c75e",
            )!;
            const dashboard = realRootSnapshot.projects.find(
              (p) => p.rootThreadId === "91f7453d-5d73-4fff-8240-8eabaa253e40",
            )!;
            expect(t3.tasks.some((task) => task.id.endsWith("#308"))).toBe(true);
            expect(dashboard.tasks.some((task) => task.id.endsWith("#303"))).toBe(true);
            expect(t3.tasks.some((task) => task.id.endsWith("#303"))).toBe(false);
            expect(briefingPlanRoot({ head: "t3", title: "T3 Orchestrator" }, shells)).toBe(
              t3.rootThreadId,
            );
            evidence.liveRootResolution = {
              t3: t3.rootThreadId,
              dashboard: dashboard.rootThreadId,
              t3Owns308: true,
              dashboardOwns303: true,
              separateRoots: true,
            };
          }
          const boundedHeaders = numbers.map((number) => ({
            number,
            epic: result.cached.issues.find((issue) => issue.number === number)?.epic ?? null,
          }));
          for (const number of numbers)
            expect(
              result.cached.issues.find((issue) => issue.number === number)?.epic,
            ).toMatchObject({
              done: result.result.issues.find((issue) => issue.number === number)!.epic!.done,
              total: result.result.issues.find((issue) => issue.number === number)!.epic!.total,
            });
          evidence[repository] = {
            boundedProjectedIssues: result.cached.issues.length,
            boundedHeaders,
            headers,
            projectedIssues: result.result.issues.length,
            visibleTasks: project.tasks.length,
            workstreams: project.workstreams.length,
            noteCoverage: result.result.repositories[0]?.noteCoverage,
            issueCalls: result.calls.filter((url) => !url.includes("/comments")).length,
            commentCalls: result.calls.filter((url) => url.includes("/comments")).length,
            perIssueCalls: result.calls.filter((url) => /\/issues\/\d+/.test(url)).length,
          };
        }
        NodeFS.writeFileSync(
          NodePath.join(fixtureDirectory, "production-pipeline.json"),
          JSON.stringify(evidence, null, 2),
        );
      }),
  );

it.effect(
  "finds newest of1500 notes, persists them across restart and reads only the incremental range (#297 B1)",
  () =>
    Effect.gen(function* () {
      const comments = Array.from({ length: 1500 }, (_, i) => ({
        id: i + 1,
        issue_url: "https://git.test/brad/repo/issues/1",
        created_at: DateTime.formatIso(DateTime.makeUnsafe(Date.parse(now) - (1500 - i) * 1000)),
        body: i === 1499 ? "Progress: next: Latest backfill" : "Discussion",
      }));
      const result = yield* runPipeline(
        [rawIssue(1)],
        comments,
        "brad/repo",
        true,
        false,
        false,
        () => {
          comments.push({
            id: 1501,
            issue_url: "https://git.test/brad/repo/issues/1",
            created_at: now,
            body: "Progress: next: Incremental",
          });
        },
        true,
        true,
      );
      expect(result.result.issues[0]?.plan?.nextStep).toBe("Latest backfill");
      expect(result.cached.issues[0]?.plan?.nextStep).toBe("Incremental");
      const initial = result.calls
        .slice(0, result.callsAfterFirst)
        .filter((url) => url.includes("/issues/comments"));
      expect(initial).toHaveLength(31);
      const after = result.calls
        .slice(result.callsAfterFirst)
        .filter((url) => url.includes("/issues/comments"));
      expect(after).toHaveLength(1);
      expect(after[0]).toContain("since=");
    }),
);

it.effect("includes canonical children beyond200open issues (#297 S3)", () =>
  Effect.gen(function* () {
    const issues = Array.from({ length: 250 }, (_, i) =>
      rawIssue(i + 1, i > 0 ? "Part of #1" : "", i === 0 ? ["ask:epic"] : ["ask:task"]),
    );
    const result = yield* runPipeline(issues, [], "brad/repo", true);
    expect(result.result.issues).toHaveLength(250);
    expect(result.result.issues[0]?.epic?.total).toBe(249);
  }),
);

it.effect(
  "resumes bounded backfill after restart without asserting partial notes latest (#297 B1)",
  () =>
    Effect.gen(function* () {
      const comments = Array.from({ length: 2501 }, (_, i) => ({
        id: i + 1,
        issue_url: "https://git.test/brad/repo/issues/1",
        created_at: now,
        body: i === 2500 ? "Progress: next: Finished backfill" : "Discussion",
      }));
      const result = yield* runPipeline(
        [rawIssue(1)],
        comments,
        "brad/repo",
        true,
        false,
        false,
        undefined,
        true,
      );
      expect(result.result.repositories[0]?.noteCoverage).toBe("bounded");
      expect(result.result.issues[0]?.plan?.nextStep).toBeNull();
      expect(result.cached.repositories[0]?.noteCoverage).toBe("complete");
      expect(result.cached.issues[0]?.plan?.nextStep).toBe("Finished backfill");
      expect(result.calls.filter((url) => url.includes("/issues/comments"))).toHaveLength(51);
    }),
);

it.effect("keeps a huge action task in the wire snapshot with truncation evidence (#297 S4)", () =>
  Effect.gen(function* () {
    const result = yield* runPipeline(
      [rawIssue(1, "- [ ] " + "x".repeat(50_000) + "\n" + "tail".repeat(50_000))],
      [],
      "brad/repo",
      true,
    );
    expect(result.result.issues[0]?.plan?.truncated).toBe(true);
    expect(result.result.issues[0]?.membershipWarnings).toContain("truncated-body");
    const compact = compactSnapshot(result.snapshot, 4000);
    expect(compact.projects[0]?.tasks.find((t) => t.id.endsWith("#1"))?.nextStep).toHaveLength(500);
  }),
);

it.effect("fetches an older note edited during pagination after restart (#297 B1 cursor)", () =>
  Effect.gen(function* () {
    const comments = Array.from({ length: 51 }, (_, i) => ({
      id: i + 1,
      issue_url: "https://git.test/brad/repo/issues/1",
      created_at: DateTime.formatIso(DateTime.makeUnsafe(Date.parse(now) - 100_000 + i * 1000)),
      updated_at: DateTime.formatIso(DateTime.makeUnsafe(Date.parse(now) - 100_000 + i * 1000)),
      body: i === 0 ? "Progress: next: Before edit" : "Discussion",
    }));
    const result = yield* runPipeline(
      [rawIssue(1)],
      comments,
      "brad/repo",
      true,
      false,
      false,
      undefined,
      true,
      false,
      () =>
        Effect.gen(function* () {
          comments[0]!.body = "Progress: next: Edited during scan";
          comments[0]!.updated_at = DateTime.formatIso(DateTime.makeUnsafe(Date.parse(now) + 1000));
          comments[50]!.updated_at = DateTime.formatIso(
            DateTime.makeUnsafe(Date.parse(now) + 5_000),
          );
          yield* TestClock.setTime(Date.parse(now) + 5_000);
        }),
    );
    expect(result.result.issues[0]?.plan?.nextStep).toBe("Before edit");
    expect(result.cached.issues[0]?.plan?.nextStep).toBe("Edited during scan");
  }),
);

it.effect("refreshes issue and repository note credentials after rotation (#297 R2-S2)", () =>
  Effect.gen(function* () {
    const result = yield* runPipeline(
      [rawIssue(1)],
      [
        {
          id: 1,
          issue_url: "https://git.test/brad/repo/issues/1",
          created_at: now,
          body: "Progress: next: Current credentials",
        },
      ],
      "brad/repo",
      true,
      false,
      false,
      undefined,
      false,
      false,
      undefined,
      true,
    );
    expect(result.cached.repositories[0]?.error).toBeNull();
    expect(result.cached.repositories[0]?.noteError).toBeNull();
    expect(result.cached.repositories[0]?.noteCoverage).toBe("complete");
    expect(result.cached.issues[0]?.plan?.nextStep).toBe("Current credentials");
  }),
);

it.effect("keeps legacy labelled-epic counting separate from tracker membership (#297 R2-S1)", () =>
  Effect.gen(function* () {
    const result = yield* runPipeline(
      [
        rawIssue(1, "- [x] #3\n- [ ] #4", ["ask:epic"]),
        rawIssue(2, "", ["ask:epic"]),
        rawIssue(3, "Part of #2"),
        { ...rawIssue(4), state: "closed", closed_at: now },
        { ...rawIssue(5, "- [ ] #3", ["ask:epic"]), state: "closed", closed_at: now },
      ],
      [],
    );
    const rows = result.result.issues;
    expect(rows.find((i) => i.number === 1)?.briefingEpic).toMatchObject({ done: 2, total: 2 });
    expect(rows.find((i) => i.number === 1)?.plan).toMatchObject({ done: 1, total: 1 });
    expect(rows.find((i) => i.number === 5)?.briefingEpic).toMatchObject({ done: 0, total: 1 });
    expect(rows.find((i) => i.number === 3)?.briefingPartOf).toBe(2);
    expect(rows.find((i) => i.number === 4)?.briefingPartOf).toBeNull();
  }),
);
