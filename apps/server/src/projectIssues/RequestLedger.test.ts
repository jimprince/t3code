import { describe, expect } from "vite-plus/test";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as TestClock from "effect/testing/TestClock";
import * as Layer from "effect/Layer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { HttpClient, HttpClientResponse } from "effect/http";
import {
  ProjectIssuesError,
  ChatAttachmentId,
  ThreadId,
  type GiteaInstanceConfig,
  ThreadIssueOperationError,
  type ProjectIssue,
} from "@t3tools/contracts";
import { ServerConfig } from "../config.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import { layerMemory as SqlitePersistenceMemory } from "../persistence/Sqlite.ts";
import * as SqlClient from "effect/sql/SqlClient";
import { initializeMetadata } from "../forkThreads/MetadataStore.ts";
import { ThreadManagementService } from "../orchestration-v2/ThreadManagementService.ts";
import { ProjectService } from "../project/ProjectService.ts";
import { RANK_GAP, parseRankTrailer, parsePlacedByTrailer } from "./requestOrder.logic.ts";
import { parseRequestMarker } from "./projectIssues.logic.ts";
import { DashboardService } from "../dashboard/DashboardService.ts";
import { make } from "./RequestLedger.ts";

const instance: GiteaInstanceConfig = {
  id: "home",
  host: "git.home",
  sshAliases: [],
  sshPorts: [2222],
  webOrigin: "http://git.home:3000",
  apiOrigin: "http://git.home:3000",
  token: "test",
};
const target = { instance, host: "git.home:3000", repository: "brad/chief-of-staff" };
const root = ThreadId.make("root");
const waiting = ThreadId.make("waiting");
const thread = (id: ThreadId, title: string) => ({
  id,
  title,
  projectId: "project",
  parentThreadId: null,
  archivedAt: null,
  updatedAt: DateTime.makeUnsafe("2026-10-06T15:00:00.000Z"),
  runtimeMode: "full-access",
  interactionMode: "default",
});
const body = [
  "Day Planner access?",
  "",
  "```decision",
  `waiting: ${waiting}`,
  "options:",
  "- Tailnet/LAN only with one password [recommended]",
  "- Needs public access",
  "```",
].join("\n");

/**
 * A fake Gitea holding issue #14: steps named in `failing` answer HTTP 500, and posted
 * comments and removed labels stick, like the real API, so a retry sees what landed.
 */
function fakeGitea() {
  const failing = new Set<string>();
  const comments: string[] = [];
  const calls: string[] = [];
  let labelled = true;
  let inProgress = false;
  const client = HttpClient.make((request) => {
    const path = new URL(request.url).pathname.replace("/api/v1/repos/brad/chief-of-staff", "");
    const step = `${request.method} ${path}`;
    calls.push(step);
    const reply = (status: number, value: unknown) =>
      Effect.succeed(
        HttpClientResponse.fromWeb(request, new Response(JSON.stringify(value), { status })),
      );
    if (failing.has(step)) return reply(500, {});
    switch (step) {
      case "GET /issues/14":
        return reply(200, {
          title: "Day Planner access",
          body,
          state: "open",
          html_url: "http://git.home:3000/brad/chief-of-staff/issues/14",
          labels: [
            ...(labelled ? [{ name: "needs-brad" }] : []),
            ...(inProgress ? [{ name: "in-progress" }] : []),
          ],
        });
      case "GET /issues/14/comments":
        return reply(
          200,
          comments.map((text) => ({ body: text, created_at: "2026-10-06T15:44:00Z" })),
        );
      case "POST /issues/14/comments": {
        const sent = request.body._tag === "Uint8Array" ? request.body.body : new Uint8Array();
        comments.push(JSON.parse(new TextDecoder().decode(sent)).body);
        return reply(201, {});
      }
      case "GET /labels":
        return reply(200, [
          { id: 7, name: "needs-brad" },
          { id: 8, name: "in-progress" },
          { id: 9, name: "needs-review" },
          { id: 10, name: "awaiting-release" },
          { id: 11, name: "needs-test" },
          { id: 12, name: "backlog" },
        ]);
      case "POST /issues/14/labels":
        inProgress = true;
        return reply(200, {});
      case "DELETE /issues/14/labels/7":
        labelled = false;
        return reply(200, {});
      default:
        return reply(404, {});
    }
  });
  return { client, failing, comments, calls };
}

/** Brad picks the recommended option on #14 from the Decisions widget. */
const withLedger = <A>(
  gitea: ReturnType<typeof fakeGitea>,
  dispatch: (command: { readonly threadId: string }) => Effect.Effect<unknown, ProjectIssuesError>,
  action: (ledger: Effect.Success<ReturnType<typeof make>>) => Effect.Effect<A, ProjectIssuesError>,
  link: (input: {
    threadId: ThreadId;
    reference: string;
  }) => Effect.Effect<unknown, ThreadIssueOperationError> = () => Effect.die("unused issue link"),
  engineOverrides: Record<string, unknown> = {},
  issueOverrides: Record<string, unknown> = {},
) =>
  Effect.gen(function* () {
    yield* initializeMetadata(yield* SqlClient.SqlClient);
    return yield* make({
      projectIssues: {
        trackerForRoot: () => Effect.succeed(null),
        repositoryForProject: () => Effect.succeed(target),
        invalidate: () => undefined,
        ...issueOverrides,
      } as never,
      threadIssues: { link } as never,
    });
  }).pipe(
    Effect.flatMap(action),
    Effect.provideService(ThreadManagementService, {
      dispatch: dispatch,
      getThreadShell: (id: ThreadId) =>
        Effect.succeed(thread(id, id === waiting ? "Day Planner" : "Chief of staff")),
      getShellSnapshot: () =>
        Effect.succeed({
          threads: [thread(root, "Chief of staff"), thread(waiting, "Day Planner")],
          archivedThreads: [],
          projects: [{ id: "project", workspaceRoot: "/repo" }],
        }),
      ...engineOverrides,
    } as never),
    Effect.provideService(ProjectService, {
      getShell: () => Effect.succeed(Option.some({ id: "project", workspaceRoot: "/repo" })),
      listShells: () => Effect.succeed([{ id: "project", workspaceRoot: "/repo" }]),
    } as never),
    Effect.provide(SqlitePersistenceMemory),
    Effect.provideService(HttpClient.HttpClient, gitea.client),
    Effect.provide(
      Layer.mergeAll(
        ServerSettingsService.layerTest({ giteaInstances: [instance] }),
        ServerConfig.layerTest(process.cwd(), { prefix: "t3-request-ledger-" }).pipe(
          Layer.provideMerge(NodeServices.layer),
        ),
      ),
    ),
  );

const answer14 = (
  gitea: ReturnType<typeof fakeGitea>,
  dispatch: (command: { readonly threadId: string }) => Effect.Effect<unknown, ProjectIssuesError>,
) =>
  withLedger(gitea, dispatch, (ledger) =>
    ledger.decide({
      threadId: root,
      reference: "brad/chief-of-staff#14",
      decision: "option",
      option: "Tailnet/LAN only with one password",
    }),
  );

const CHOSE = "Brad chose: Tailnet/LAN only with one password";

describe("answering a decision", () => {
  it.effect("fails with what landed when the label stays, and a retry finishes once", () =>
    Effect.gen(function* () {
      const gitea = fakeGitea();
      const told: string[] = [];
      const dispatch = (command: { readonly threadId: string }) => {
        told.push(command.threadId);
        return Effect.succeed({});
      };

      gitea.failing.add("DELETE /issues/14/labels/7");
      const failed = yield* Effect.flip(answer14(gitea, dispatch));
      expect(failed.message).toBe(
        "The answer is on brad/chief-of-staff#14, but its needs-brad label stayed: Gitea API returned HTTP 500.",
      );
      expect(told).toEqual([]);

      gitea.failing.clear();
      const retried = yield* answer14(gitea, dispatch);
      expect(retried).toEqual({ notifiedThreadId: waiting });
      expect(gitea.comments).toEqual([CHOSE]);
      expect(told).toEqual([waiting]);
    }),
  );

  it.effect("fails when the waiting thread cannot be told, and a retry only tells it", () =>
    Effect.gen(function* () {
      const gitea = fakeGitea();
      const told: string[] = [];
      let refuse = true;
      const dispatch = (command: { readonly threadId: string }) => {
        if (refuse) return Effect.fail(new ProjectIssuesError({ message: "Thread is archived." }));
        told.push(command.threadId);
        return Effect.succeed({});
      };

      const failed = yield* Effect.flip(answer14(gitea, dispatch));
      expect(failed.message).toBe(
        "The answer is on brad/chief-of-staff#14, but Day Planner was not told: Thread is archived.",
      );
      expect(gitea.comments).toEqual([CHOSE]);

      // The label is off now, so only the decision block routes the retry to the answer.
      refuse = false;
      gitea.calls.length = 0;
      const retried = yield* answer14(gitea, dispatch);
      expect(retried).toEqual({ notifiedThreadId: waiting });
      expect(gitea.comments).toEqual([CHOSE]);
      expect(gitea.calls).toEqual(["GET /issues/14", "GET /issues/14/comments"]);
      expect(told).toEqual([waiting]);
    }),
  );
});

it.effect(
  "starting a task records its stage and link, retries without duplicate comments and propagates a failed link",
  () =>
    Effect.gen(function* () {
      const gitea = fakeGitea();
      const links: Array<{ threadId: ThreadId; reference: string }> = [];
      let reject = true;
      const start = () =>
        withLedger(
          gitea,
          () => Effect.die("unused dispatch"),
          (ledger) =>
            ledger.update({
              threadId: waiting,
              reference: "brad/chief-of-staff#14",
              status: "in-progress",
            }),
          (input) => {
            if (reject)
              return Effect.fail(new ThreadIssueOperationError({ message: "Cannot persist link" }));
            links.push(input);
            return Effect.succeed({});
          },
        );
      expect((yield* start().pipe(Effect.flip)).message).toBe("Cannot persist link");
      expect(gitea.comments).toEqual(["Progress: started"]);
      reject = false;
      yield* start();
      yield* start();
      expect(gitea.comments).toEqual(["Progress: started"]);
      expect(links).toEqual([
        { threadId: waiting, reference: "http://git.home:3000/brad/chief-of-staff/issues/14" },
        { threadId: waiting, reference: "http://git.home:3000/brad/chief-of-staff/issues/14" },
      ]);
      expect(gitea.calls.filter((step) => step === "POST /issues/14/labels")).toHaveLength(1);
    }),
);

it.effect.each(
  [
    ["No change.", true],
    ["Nothing new for you.", true],
    [" \nNo change.\r\n ", true],
    ["\tNothing new for you.\n", true],
    ["No change. More text.", false],
    ["No change.\n\nAnother paragraph.", false],
    ["Nothing new for you. T3_NOTIFY: quiet", false],
    ["no change", false],
    ["**No change.**", false],
    ["Found No change. in the log.", false],
  ].map(([text, silent], key) => ({ text: text as string, silent: silent as boolean, key })),
)(
  "ledger decorates final output %j without filing an assistant request",
  ({ text, silent, key }) => {
    const gitea = fakeGitea();
    const messageId = `message:ledger-no-change:${key}`;
    const now = DateTime.makeUnsafe("2026-10-12T00:00:00Z");
    const messages = [
      {
        id: messageId,
        runId: "run",
        role: "user",
        text: "Check for changes.",
        streaming: false,
        createdAt: now,
      },
      {
        id: `${messageId}:reply`,
        runId: "run",
        role: "assistant",
        text,
        streaming: false,
        createdAt: now,
      },
    ];
    return withLedger(
      gitea,
      () => Effect.die("unexpected dispatch"),
      (ledger) =>
        Effect.gen(function* () {
          const issues = [
            { isRequest: true, closedAt: null, requestSource: { messageId, threadId: root } },
          ];
          const decorated = yield* ledger.withAnswers(issues as never);
          expect(decorated[0]?.answer?.text ?? null).toBe(silent ? null : text.trim());
          yield* ledger.observeDispatch(
            { type: "message.updated", threadId: root, messageId: `${messageId}:reply`, text },
            "web",
          );
          expect(gitea.calls).toEqual([]);
          expect(messages[1]?.text).toBe(text);
        }),
      undefined,
      {
        getShellSnapshot: () =>
          Effect.succeed({
            threads: [{ ...thread(root, "Root"), latestRunId: "run", activeRunId: null }],
            archivedThreads: [],
          }),
        getThreadProjection: () => Effect.succeed({ messages }),
      },
    );
  },
);

function filingGitea() {
  const labels = [
    { id: 1, name: "ask" },
    { id: 2, name: "ask:task" },
    { id: 3, name: "ask:epic" },
    { id: 4, name: "bug" },
  ];
  const records = new Map<number, { title: string; body: string; labels: number[]; state: string }>(
    [[8, { title: "Epic", body: "Epic\n<!-- t3:rank 1024 -->", labels: [1, 3], state: "open" }]],
  );
  const failing = new Set<string>();
  const comments: string[] = [];
  const calls: string[] = [];
  let counter = 20;
  const client = HttpClient.make((request) => {
    const path = new URL(request.url).pathname.replace("/api/v1/repos/brad/chief-of-staff", "");
    calls.push(`${request.method} ${path}`);
    const payload =
      request.body._tag === "Uint8Array"
        ? JSON.parse(new TextDecoder().decode(request.body.body))
        : {};
    const reply = (status: number, data: unknown) =>
      Effect.succeed(
        HttpClientResponse.fromWeb(request, new Response(JSON.stringify(data), { status })),
      );
    if (failing.has(`${request.method} ${path}`)) return reply(500, {});
    if (path === "/labels" && request.method === "GET") return reply(200, labels);
    if (path === "/issues" && request.method === "POST") {
      const number = ++counter;
      records.set(number, { ...payload, state: "open" });
      return reply(201, {
        number,
        html_url: `http://git.home:3000/brad/chief-of-staff/issues/${number}`,
      });
    }
    const number = Number(path.split("/")[2]);
    const row = records.get(number);
    if (!row) return reply(404, {});
    if (path.endsWith("/comments") && request.method === "POST") {
      comments.push(payload.body);
      return reply(201, {});
    }
    if (request.method === "PATCH") Object.assign(row, payload);
    return reply(200, {
      ...row,
      html_url: `http://git.home:3000/brad/chief-of-staff/issues/${number}`,
      labels: row.labels.map((id) => labels.find((l) => l.id === id)),
    });
  });
  const list = () =>
    Effect.succeed({
      repositories: [{ host: target.host, repository: target.repository, error: null }],
      fetchedAt: "2026-10-14T00:00:00Z",
      issues: [...records.entries()].map(
        ([number, row]): ProjectIssue => ({
          host: target.host,
          repository: target.repository,
          number,
          title: row.title,
          url: `http://git.home:3000/brad/chief-of-staff/issues/${number}`,
          status: "pending",
          labels: row.labels.map((id) => labels.find((l) => l.id === id)!.name),
          isRequest: true,
          requestSource: parseRequestMarker(row.body),
          assignees: [],
          comments: 0,
          createdAt: "2026-10-14T00:00:00Z",
          updatedAt: "2026-10-14T00:00:00Z",
          closedAt: row.state === "closed" ? "2026-10-14T01:00:00Z" : null,
          linkedThreadIds: [],
          rank: parseRankTrailer(row.body),
          placedBy: parsePlacedByTrailer(row.body),
          ...(row.body.startsWith("Part of #8") ? { partOf: 8 } : {}),
        }),
      ),
    });
  return { client, records, comments, calls, list, failing };
}
describe("typed request filing", () => {
  it.effect(
    "files exact words into an epic, places once, then notifies; message retry and capture do not duplicate it",
    () => {
      const gitea = filingGitea();
      const sent: string[] = [];
      let refreshed = 0;
      const refreshedReceipt = Deferred.makeUnsafe<void>();
      const text = "  Fix the layout  \nKeep this line exactly.\n";
      return withLedger(
        gitea,
        () =>
          Effect.sync(() => {
            sent.push("notified");
            expect(gitea.records.size).toBe(2);
          }),
        (ledger) =>
          Effect.gen(function* () {
            const input = {
              threadId: root,
              title: "Fix the layout",
              kind: "task" as const,
              bug: true,
              detail: text,
              partOf: 8,
              place: { to: "bottom" as const },
              actor: "brad" as const,
              messageId: "typed-once",
            };
            const first = yield* ledger.create(input);
            const second = yield* ledger.create(input);
            yield* ledger.capture({ threadId: root, messageId: "typed-once", text });
            expect(first.request?.number).toBe(21);
            expect(first).toMatchObject({ notifiedThreadId: root });
            expect(second.request?.number).toBe(21);
            expect(gitea.calls.filter((c) => c === "POST /issues")).toHaveLength(1);
            const row = gitea.records.get(21)!;
            expect(row.body.startsWith("Part of #8\n\n## Brad's words")).toBe(true);
            expect(row.body).toContain(">   Fix the layout  \n> Keep this line exactly.");
            expect(row.labels).toContain(4);
            expect(parseRankTrailer(row.body)).toBe(RANK_GAP);
            expect(parsePlacedByTrailer(row.body)).toEqual({ kind: "brad" });
            expect(sent).toEqual(["notified"]);
            yield* Deferred.await(refreshedReceipt);
            expect(refreshed).toBeGreaterThan(0);
          }),
        () => Effect.void,
        {},
        { list: gitea.list },
      ).pipe(
        Effect.provideService(DashboardService, {
          refresh: Effect.sync(() => {
            refreshed++;
          }).pipe(Effect.andThen(Deferred.succeed(refreshedReceipt, undefined))),
        } as never),
      );
    },
  );
  it.effect(
    "leaves an agent's filing new without placement, and sets or clears its epic without editing the quote",
    () => {
      const gitea = filingGitea();
      return withLedger(
        gitea,
        () => Effect.void,
        (ledger) =>
          Effect.gen(function* () {
            const created = yield* ledger.create({
              threadId: root,
              title: "New task",
              kind: "task",
              detail: "Brad's exact words",
            });
            expect(created.queued).toBe(false);
            expect(parseRankTrailer(gitea.records.get(21)?.body)).toBeNull();
            yield* ledger.update({ threadId: root, reference: "21", partOf: 8 });
            expect(gitea.records.get(21)?.body).toMatch(/^Part of #8/);
            yield* ledger.update({ threadId: root, reference: "21", partOf: null });
            expect(gitea.records.get(21)?.body).toMatch(/^## Brad's words/);
            expect(gitea.records.get(21)?.body).toContain("> Brad's exact words");
            expect((yield* ledger.queue({ threadId: root })).new.map((i) => i.number)).toContain(
              21,
            );
          }),
        () => Effect.void,
        {},
        { list: gitea.list },
      );
    },
  );
});

describe("request duplicate and epic lifecycle", () => {
  it.effect("closes a duplicate with links in both issues and supports reopening", () => {
    const gitea = filingGitea();
    return withLedger(
      gitea,
      () => Effect.void,
      (ledger) =>
        Effect.gen(function* () {
          yield* ledger.create({
            threadId: root,
            title: "Duplicate task",
            kind: "task",
            detail: "Keep Brad's words",
          });
          yield* ledger.update({
            threadId: root,
            reference: "21",
            duplicateOf: "8",
            actor: "brad",
          });
          expect(gitea.records.get(21)?.state).toBe("closed");
          expect(gitea.comments).toEqual(["Duplicate of #8", "Duplicate: #21"]);
          expect(gitea.records.get(21)?.body).toContain("> Keep Brad's words");
          yield* ledger.settle({
            rootThreadId: root,
            host: target.host,
            repository: target.repository,
            number: 21,
            reopen: true,
          });
          expect(gitea.records.get(21)?.state).toBe("open");
        }),
      () => Effect.void,
      {},
      { list: gitea.list, resolveProject: () => Effect.succeed({ targets: [target] }) },
    );
  });
  it.effect("rejects filing an epic inside another epic before creating an issue", () => {
    const gitea = filingGitea();
    return withLedger(
      gitea,
      () => Effect.void,
      (ledger) =>
        Effect.gen(function* () {
          const result = yield* Effect.exit(
            ledger.create({ threadId: root, title: "Nested epic", kind: "epic", partOf: 8 }),
          );
          expect(result._tag).toBe("Failure");
          expect(gitea.records.size).toBe(1);
          expect(gitea.calls).not.toContain("POST /issues");
        }),
      () => Effect.void,
      {},
      { list: gitea.list },
    );
  });
});

it.effect("a queued direct filing retains epic, placement, words and notification intent", () =>
  Effect.gen(function* () {
    const gitea = filingGitea();
    let available = false;
    const notified = yield* Deferred.make<void>();
    yield* withLedger(
      gitea,
      () => Deferred.succeed(notified, undefined),
      (ledger) =>
        Effect.gen(function* () {
          const input = {
            threadId: root,
            title: "File after recovery",
            kind: "task" as const,
            detail: "Brad's original words  ",
            messageId: "deferred-once",
            partOf: 8,
            place: { to: "bottom" as const },
            actor: "brad" as const,
          };
          const queued = yield* ledger.create(input);
          expect(queued).toMatchObject({ request: null, queued: true });
          available = true;
          yield* TestClock.adjust("31 seconds");
          yield* Deferred.await(notified);
          // The same global filing semaphore also waits for the outbox worker to finish.
          const retried = yield* ledger.create(input);
          yield* ledger.waitForDrain;
          expect(retried.request?.number).toBe(21);
          expect(gitea.records.size).toBe(2);
          expect(gitea.records.get(21)?.body).toContain("> Brad's original words  ");
          expect(gitea.records.get(21)?.body).toMatch(/^Part of #8/);
          expect(parseRankTrailer(gitea.records.get(21)?.body)).toBe(RANK_GAP);
          expect(parsePlacedByTrailer(gitea.records.get(21)?.body)).toEqual({ kind: "brad" });
        }),
      () => Effect.void,
      {},
      {
        list: () =>
          available
            ? gitea.list()
            : Effect.succeed({
                repositories: [
                  {
                    host: target.host,
                    repository: target.repository,
                    error: "Gitea is unreachable.",
                  },
                ],
                issues: [],
                fetchedAt: "2026-10-14T00:00:00Z",
              }),
      },
    );
  }),
);

it.effect(
  "records the agent that placed a filing, separately from its target project thread",
  () => {
    const gitea = filingGitea();
    return withLedger(
      gitea,
      () => Effect.void,
      (ledger) =>
        Effect.gen(function* () {
          yield* ledger.create({
            threadId: root,
            actorThreadId: waiting,
            title: "Placed by Day Planner",
            kind: "task",
            partOf: 8,
            place: { to: "bottom" },
          });
          expect(parsePlacedByTrailer(gitea.records.get(21)?.body)).toEqual({
            kind: "agent",
            threadId: waiting,
            name: "Day Planner",
          });
        }),
      () => Effect.void,
      {},
      { list: gitea.list },
    );
  },
);

it.effect("reports failed placement as filed, notifies and retries without a second POST", () => {
  const gitea = filingGitea();
  let notifications = 0;
  return withLedger(
    gitea,
    () =>
      Effect.sync(() => {
        notifications++;
      }),
    (ledger) =>
      Effect.gen(function* () {
        const input = {
          threadId: root,
          title: "File once",
          kind: "task" as const,
          messageId: "bad-placement",
          partOf: 8,
          place: { to: "after" as const, reference: "999" },
        };
        const first = yield* ledger.create(input);
        const again = yield* ledger.create(input);
        expect(first.request?.number).toBe(21);
        expect(first.queued).toBe(false);
        expect(first.placeError).toContain("ordered, queued sibling");
        expect(again.placeError).toBe(first.placeError);
        expect(gitea.calls.filter((call) => call === "POST /issues")).toHaveLength(1);
        expect(parseRankTrailer(gitea.records.get(21)?.body)).toBeNull();
        expect(notifications).toBe(1);
      }),
    () => Effect.void,
    {},
    { list: gitea.list },
  );
});
it.effect("an outbox placement failure finishes filing instead of retrying forever", () =>
  Effect.gen(function* () {
    const gitea = filingGitea();
    let available = false;
    const notified = yield* Deferred.make<void>();
    yield* withLedger(
      gitea,
      () => Deferred.succeed(notified, undefined),
      (ledger) =>
        Effect.gen(function* () {
          yield* ledger.create({
            threadId: root,
            title: "Queued once",
            kind: "task",
            messageId: "queued-bad-place",
            partOf: 8,
            place: { to: "after", reference: "999" },
          });
          available = true;
          yield* TestClock.adjust("31 seconds");
          yield* Deferred.await(notified);
          yield* ledger.waitForDrain;
          expect(gitea.calls.filter((call) => call === "POST /issues")).toHaveLength(1);
          expect(parseRankTrailer(gitea.records.get(21)?.body)).toBeNull();
        }),
      () => Effect.void,
      {},
      {
        list: () =>
          available
            ? gitea.list()
            : Effect.succeed({
                repositories: [
                  { host: target.host, repository: target.repository, error: "Offline" },
                ],
                issues: [],
                fetchedAt: "2026-10-14T00:00:00Z",
              }),
      },
    );
  }),
);

it.effect("post-create attachment errors return the filed issue and do not queue a retry", () => {
  const gitea = filingGitea();
  return withLedger(
    gitea,
    () => Effect.void,
    (ledger) =>
      Effect.gen(function* () {
        const input = {
          threadId: root,
          title: "Keep filed",
          kind: "task" as const,
          messageId: "bad-attachment",
          detail: "   ",
          attachments: [
            {
              id: ChatAttachmentId.make("missing"),
              type: "image" as const,
              name: "photo.png",
              mimeType: "image/png",
              sizeBytes: 10,
            },
          ],
        };
        const first = yield* ledger.create(input);
        const again = yield* ledger.create(input);
        expect(first.queued).toBe(false);
        expect(first.request?.number).toBe(21);
        expect(first.attachmentError).toBeTruthy();
        expect(again.attachmentError).toBe(first.attachmentError);
        expect(gitea.calls.filter((call) => call === "POST /issues")).toHaveLength(1);
        expect(gitea.records.get(21)?.body).toContain("> Keep filed");
      }),
    () => Effect.void,
    {},
    { list: gitea.list },
  );
});

it.effect("rejects an agent duplicate close before any tracker call", () => {
  const gitea = filingGitea();
  return withLedger(
    gitea,
    () => Effect.void,
    (ledger) =>
      Effect.gen(function* () {
        const error = yield* ledger
          .update({ threadId: root, reference: "8", duplicateOf: "21" })
          .pipe(Effect.flip, Effect.orDie);
        expect(error.message).toContain("Only Brad can close a duplicate");
        expect(gitea.calls).toEqual([]);
        expect(gitea.records.get(8)?.state).toBe("open");
      }),
  );
});
