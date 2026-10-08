import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import {
  CommandId,
  ProjectId,
  ProviderInstanceId,
  RuntimeRequestId,
  ThreadId,
  type GiteaInstanceConfig,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { describe, expect } from "vite-plus/test";

import { ServerConfig } from "../config.ts";
import { makeNestingService } from "../forkThreads/NestingService.ts";
import * as ThreadIssueService from "../forkThreads/ThreadIssueService.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import { makeOrchestratorV2ReplayLayerWithRegistry } from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { ProjectService } from "../project/ProjectService.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { AT, insertQuestion, insertRequest } from "./pendingAsks.testkit.ts";
import * as DecisionFeed from "./DecisionFeed.ts";
import * as ProjectIssuesService from "./ProjectIssuesService.ts";
import * as RequestLedger from "./RequestLedger.ts";

const database = SqlitePersistenceMemory;
const nativeRuntime = makeOrchestratorV2ReplayLayerWithRegistry(
  { name: "decision-feed" },
  ProviderAdapterRegistry.makeLayer([]),
  { databaseLayer: database, runEffectWorker: false },
);
const nativeLayer = ThreadManagement.layer.pipe(
  Layer.provide(nativeRuntime),
  Layer.provideMerge(database),
);

type RecordedCommand = Parameters<
  ThreadManagement.ThreadManagementService["Service"]["dispatch"]
>[0];

const NOW = "2026-10-06T00:00:00.000Z";
const REPO = "brad/t3code-fork";
const ISSUE_URL = (number: number) => `http://git.home:3000/${REPO}/issues/${number}`;
const instance: GiteaInstanceConfig = {
  id: "home",
  host: "git.home",
  sshAliases: [],
  sshPorts: [2222],
  webOrigin: "http://git.home:3000",
  apiOrigin: "http://git.home:3000",
  token: "",
};
const project = {
  id: "project",
  title: "Printcell",
  workspaceRoot: "/repo",
  repositoryIdentity: {
    provider: "gitea",
    canonicalKey: "git.home/brad/t3code-fork",
    locator: { remoteUrl: "ssh://git@git.home:2222/brad/t3code-fork.git" },
  },
};
const claude = { instanceId: ProviderInstanceId.make("claude"), model: "claude-opus-5-5" };

const ROOT = ThreadId.make("root");
const OWNER = ThreadId.make("owner");
const WORKER = ThreadId.make("worker");

interface ShellThread {
  readonly id: ThreadId;
  readonly title: string;
  readonly parentThreadId: ThreadId | null;
  readonly archivedAt: string | null;
  readonly linked?: number;
  readonly pending?: "user_input" | "command";
}

const linkTo = (number: number) => ({
  host: "git.home:3000",
  repository: REPO,
  number,
  url: ISSUE_URL(number),
  linkedAt: NOW,
  snapshot: { title: `#${number}`, state: "open" as const, syncedAt: NOW },
});

const baseThreads: ReadonlyArray<ShellThread> = [
  { id: ROOT, title: "T3 Orchestrator", parentThreadId: null, archivedAt: null },
  { id: OWNER, title: "End Effector Orchestrator", parentThreadId: ROOT, archivedAt: null },
  { id: WORKER, title: "Gripper worker", parentThreadId: ROOT, archivedAt: null, linked: 7 },
];

const decisionBody = [
  "Which tool changer set should be printed next?",
  "deadline: 2026-10-08",
  "",
  "```decision",
  "waiting: owner",
  "options:",
  "- Magnet set [recommended]",
  "- Slider set",
  "```",
  "",
  `<!-- t3-deferral ${JSON.stringify({ until: "2026-10-07T12:00:00.000Z", movedToEndAt: null })} -->`,
].join("\n");

interface FakePull {
  readonly number: number;
  readonly title: string;
  readonly body: string;
  readonly mergeable?: boolean;
  readonly draft?: boolean;
  readonly merged?: boolean;
  readonly mergedAt?: string;
}

const makeHarness = (options: {
  readonly threads?: ReadonlyArray<ShellThread>;
  readonly pulls?: ReadonlyArray<FakePull>;
  readonly issueState?: "open" | "closed";
  readonly mergeStatus?: number;
  /** Comments already on every issue, oldest first. */
  readonly comments?: ReadonlyArray<{ body: string; created_at: string }>;
  /** Timeline events of every issue, e.g. a reopen. */
  readonly timeline?: ReadonlyArray<{ type: string; created_at: string }>;
}) =>
  Effect.gen(function* () {
    const threads = options.threads ?? baseThreads;
    // Merging marks the pull request merged, as Gitea does.
    const pulls: FakePull[] = (options.pulls ?? []).map((pull) => ({ ...pull }));
    const issues = [
      {
        number: 4,
        title: "Which tool changer set should be printed next?",
        body: decisionBody,
        state: "open",
        html_url: ISSUE_URL(4),
        labels: [{ id: 9, name: "needs-brad" }],
        comments: 0,
        created_at: NOW,
        updated_at: NOW,
      },
      {
        number: 7,
        title: "Rebase dispatch acts on a stale merge verdict",
        body: "",
        state: options.issueState ?? "open",
        html_url: ISSUE_URL(7),
        labels: [{ id: 3, name: "needs-review" }],
        comments: 0,
        created_at: NOW,
        updated_at: NOW,
      },
    ];
    const writes: Array<{ method: string; path: string; body: unknown }> = [];
    const control: {
      failClose: boolean;
      mergeLandsDespiteError: boolean;
      /** Holds a merge request open until `release` is completed. */
      gate: { reached: Deferred.Deferred<void>; release: Deferred.Deferred<void> } | null;
    } = { failClose: false, mergeLandsDespiteError: false, gate: null };
    const commands: RecordedCommand[] = [];
    let uuid = 0;
    const json = (
      request: Parameters<Parameters<typeof HttpClient.make>[0]>[0],
      value: unknown,
      status = 200,
    ) =>
      // Yielding lets concurrent requests interleave, as they do over a real connection.
      Effect.yieldNow.pipe(
        Effect.as(
          HttpClientResponse.fromWeb(request, new Response(JSON.stringify(value), { status })),
        ),
      );
    const http = HttpClient.make((request) => {
      const url = new URL(request.url);
      const path = url.pathname.replace("/api/v1", "");
      if (request.method !== "GET") {
        const body =
          request.body._tag === "Uint8Array"
            ? JSON.parse(new TextDecoder().decode(request.body.body))
            : null;
        writes.push({ method: request.method, path, body });
        if (control.failClose && request.method === "PATCH" && typeof body?.state === "string") {
          return json(request, {}, 500);
        }
        const edited = /\/issues\/(\d+)$/.exec(path);
        if (request.method === "PATCH" && edited && typeof body?.state === "string") {
          const issue = issues.find((candidate) => candidate.number === Number(edited[1]));
          if (issue) issue.state = body.state;
        }
        if (path.endsWith("/merge")) {
          const merged = /\/pulls\/(\d+)\/merge$/.exec(path);
          const refused = options.mergeStatus !== undefined;
          // Gitea marks the pull request merged when the merge completes, not when it is asked.
          const complete = Effect.sync(() => {
            const index = pulls.findIndex((pull) => pull.number === Number(merged?.[1]));
            if (index >= 0 && (!refused || control.mergeLandsDespiteError)) {
              pulls[index] = { ...pulls[index]!, merged: true };
            }
          });
          const gate = control.gate;
          const held = gate
            ? Deferred.succeed(gate.reached, undefined).pipe(
                Effect.andThen(Deferred.await(gate.release)),
              )
            : Effect.void;
          return held.pipe(
            Effect.andThen(complete),
            Effect.andThen(json(request, {}, refused ? options.mergeStatus : 200)),
          );
        }
        return json(request, {});
      }
      if (path.endsWith("/labels")) {
        return json(
          request,
          ["needs-review", "in-progress", "backlog", "awaiting-release", "needs-test"]
            .map((name, index) => ({ id: 3 + index, name }))
            .concat([{ id: 9, name: "needs-brad" }]),
        );
      }
      if (path.endsWith("/timeline")) return json(request, options.timeline ?? []);
      if (path.endsWith("/comments")) {
        return json(request, [
          ...(options.comments ?? []),
          ...writes
            .filter((write) => write.method === "POST" && write.path === path)
            .map((write) => ({ body: (write.body as { body: string }).body, created_at: NOW })),
        ]);
      }
      const pull = /\/pulls\/(\d+)$/.exec(path);
      if (pull) {
        const found = pulls.find((candidate) => candidate.number === Number(pull[1]));
        return json(request, {
          state: found?.merged ? "closed" : "open",
          html_url: `http://git.home:3000/${REPO}/pulls/${pull[1]}`,
          base: { ref: "main" },
          head: { sha: "abc123" },
          merged_at: found?.merged ? (found.mergedAt ?? NOW) : null,
          ...found,
        });
      }
      if (path.endsWith("/pulls")) {
        const closed = url.searchParams.get("state") === "closed";
        return json(
          request,
          pulls.filter((candidate) => (candidate.merged === true) === closed),
        );
      }
      const single = /\/issues\/(\d+)$/.exec(path);
      if (single) {
        return json(
          request,
          issues.find((issue) => issue.number === Number(single[1])),
        );
      }
      if (path.endsWith("/issues")) {
        return json(request, url.searchParams.get("state") === "open" ? issues : []);
      }
      return json(request, []);
    });
    const nativeContext = yield* Layer.build(nativeLayer);
    const management = yield* ThreadManagement.ThreadManagementService.pipe(
      Effect.provide(nativeContext),
    );
    const sql = yield* SqlClient.SqlClient.pipe(Effect.provide(nativeContext));
    const nesting = yield* makeNestingService(sql, management.getThreadShell, management.dispatch);
    for (const shell of threads) {
      yield* management.dispatch({
        type: "thread.create",
        commandId: CommandId.make(`create-${shell.id}`),
        threadId: shell.id,
        projectId: ProjectId.make("project"),
        title: shell.title,
        modelSelection: claude,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdBy: "user",
        creationSource: "web",
      });
      if (shell.parentThreadId) {
        yield* nesting.update({
          commandId: CommandId.make(`nest-${shell.id}`),
          threadId: shell.id,
          parentThreadId: shell.parentThreadId,
        });
      }
      if (shell.archivedAt) {
        yield* management.dispatch({
          type: "thread.archive",
          commandId: CommandId.make(`archive-${shell.id}`),
          threadId: shell.id,
        });
      }
    }
    const withFork = <T extends { readonly id: string }>(shell: T) => {
      const source = threads.find((candidate) => candidate.id === shell.id);
      return {
        ...shell,
        issues: source?.linked === undefined ? [] : [linkTo(source.linked)],
        ...(source?.pending
          ? {
              pendingRuntimeRequest: {
                id: RuntimeRequestId.make("request-1"),
                kind: source.pending,
                createdAt: NOW,
              },
            }
          : {}),
      };
    };
    const services = Layer.mergeAll(
      Layer.succeedContext(nativeContext),
      Layer.succeed(ThreadManagement.ThreadManagementService, {
        ...management,
        getShellSnapshot: () =>
          management.getShellSnapshot().pipe(
            Effect.map((snapshot) => ({
              ...snapshot,
              threads: snapshot.threads.map(withFork),
              archivedThreads: snapshot.archivedThreads.map(withFork),
            })),
          ),
        dispatch: (command) => {
          commands.push(command);
          if (command.type === "message.dispatch") return Effect.succeed({}) as never;
          return management.dispatch(command);
        },
      }),
      Layer.mock(ProjectService)({
        getShell: () => Effect.succeed(Option.some(project) as never),
        listShells: () => Effect.succeed([project] as never),
      }),
      Layer.succeed(HttpClient.HttpClient, http),
      Layer.succeed(
        Crypto.Crypto,
        Crypto.make({
          randomBytes: (size) => new Uint8Array(size).fill(++uuid % 256),
          digest: (_algorithm, data) => Effect.succeed(data),
        }),
      ),
      ServerSettingsService.layerTest({ giteaInstances: [instance] }),
      ServerConfig.layerTest(process.cwd(), { prefix: "t3-decision-feed-" }).pipe(
        Layer.provideMerge(NodeServices.layer),
      ),
    );
    const context = yield* Layer.build(services);
    const built = yield* Effect.gen(function* () {
      const projectIssues = yield* ProjectIssuesService.make;
      const ledger = yield* RequestLedger.make({
        projectIssues,
        threadIssues: yield* ThreadIssueService.make,
      });
      const feed = yield* DecisionFeed.make({ projectIssues, ledger });
      return { projectIssues, ledger, feed };
    }).pipe(Effect.provide(context));
    return { ...built, writes, commands, sql, control };
  });

const messages = (commands: ReadonlyArray<RecordedCommand>) =>
  commands.flatMap((command) =>
    command.type === "message.dispatch" ? [{ threadId: command.threadId, text: command.text }] : [],
  );
const mergeCalls = (writes: ReadonlyArray<{ method: string; path: string }>) =>
  writes.filter((write) => write.path.endsWith("/merge"));

const closingPull = (extra: Partial<FakePull> = {}): FakePull => ({
  number: 195,
  title: "fix(rebase): re-check the branch first",
  body: "Closes #7",
  mergeable: true,
  ...extra,
});

describe("Approve and merge", () => {
  it.effect("merges a clean pull request, then settles the issue and tells the worker", () =>
    Effect.gen(function* () {
      const { feed, writes, commands } = yield* makeHarness({ pulls: [closingPull()] });
      const result = yield* feed.approveAndMerge({ threadId: ROOT, reference: `${REPO}#7` });

      expect(result.pullRequest.number).toBe(195);
      expect(result.notifiedThreadId).toBe(WORKER);
      expect(writes.map((write) => `${write.method} ${write.path}`)).toEqual([
        `POST /repos/${REPO}/pulls/195/merge`,
        `POST /repos/${REPO}/issues/7/comments`,
        `PATCH /repos/${REPO}/issues/7`,
      ]);
      // Pinned to the commit Brad was shown, so a later push is not merged unreviewed.
      expect(writes[0]?.body).toEqual({ Do: "merge", head_commit_id: "abc123" });
      expect(writes[2]?.body).toEqual({ state: "closed" });
      expect(messages(commands)[0]?.threadId).toBe(WORKER);
    }),
  );

  it.effect("a retry after the merge finishes settling without merging twice", () =>
    Effect.gen(function* () {
      // The merge went through, but closing the issue did not: the pull request is merged, the issue open.
      const half = yield* makeHarness({ pulls: [closingPull({ merged: true })] });
      const result = yield* half.feed.approveAndMerge({ threadId: ROOT, reference: "7" });

      expect(result).toMatchObject({ pullRequest: { number: 195 }, alreadyMerged: true });
      expect(mergeCalls(half.writes)).toEqual([]);
      expect(half.writes.map((write) => `${write.method} ${write.path}`)).toEqual([
        `POST /repos/${REPO}/issues/7/comments`,
        `PATCH /repos/${REPO}/issues/7`,
      ]);

      // Repeating it again, now that the issue is closed, changes nothing and answers the same.
      const again = yield* half.feed.approveAndMerge({ threadId: ROOT, reference: "7" });
      expect(again).toMatchObject({ pullRequest: { number: 195 }, alreadyMerged: true });
      expect(half.writes).toHaveLength(2);
    }),
  );

  it.effect("does not post its comment twice when closing the issue failed and was retried", () =>
    Effect.gen(function* () {
      const { feed, writes, control } = yield* makeHarness({ pulls: [closingPull()] });
      control.failClose = true;
      const first = yield* Effect.exit(feed.approveAndMerge({ threadId: ROOT, reference: "7" }));
      expect(String(first)).toContain("PR 195 is merged, but");
      control.failClose = false;
      // The merge itself landed on the first try, so the retry only closes the issue.
      const retried = yield* feed.approveAndMerge({ threadId: ROOT, reference: "7" });
      expect(retried.alreadyMerged).toBe(true);
      expect(mergeCalls(writes)).toHaveLength(1);
      expect(writes.filter((write) => write.path.endsWith("/issues/7/comments"))).toHaveLength(1);
    }),
  );

  it.effect("a second tap waits for the first instead of sending another merge", () =>
    Effect.gen(function* () {
      const { feed, writes, control } = yield* makeHarness({ pulls: [closingPull()] });
      const reached = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      control.gate = { reached, release };
      const approve = feed.approveAndMerge({ threadId: ROOT, reference: "7" });
      const first = yield* Effect.forkChild(approve);
      yield* Deferred.await(reached);
      const second = yield* Effect.forkChild(approve);
      // Let the second tap run as far as it can while the first merge is still in flight.
      for (let turn = 0; turn < 200; turn++) yield* Effect.yieldNow;
      expect(mergeCalls(writes)).toHaveLength(1);

      yield* Deferred.succeed(release, undefined);
      const results = [yield* Fiber.join(first), yield* Fiber.join(second)];
      expect(mergeCalls(writes)).toHaveLength(1);
      expect(results.map((result) => result.alreadyMerged)).toEqual([false, true]);
      expect(results[0]?.pullRequest).toEqual(results[1]?.pullRequest);
    }),
  );

  it.effect("carries on when Gitea refuses a merge that had in fact landed", () =>
    Effect.gen(function* () {
      const { feed, writes, control } = yield* makeHarness({
        pulls: [closingPull()],
        mergeStatus: 405,
      });
      control.mergeLandsDespiteError = true;
      const result = yield* feed.approveAndMerge({ threadId: ROOT, reference: "7" });
      expect(result.pullRequest.number).toBe(195);
      expect(writes.at(-1)).toMatchObject({ method: "PATCH", body: { state: "closed" } });
    }),
  );

  it.effect(
    "does not settle a reopened issue against a pull request merged before it was sent back",
    () =>
      Effect.gen(function* () {
        const { feed, writes } = yield* makeHarness({
          pulls: [closingPull({ merged: true, mergedAt: "2026-10-05T00:00:00.000Z" })],
          comments: [
            {
              body: "Brad sent this back:\n\nBroken on the phone",
              created_at: "2026-10-06T00:00:00.000Z",
            },
          ],
        });
        const exit = yield* Effect.exit(feed.approveAndMerge({ threadId: ROOT, reference: "7" }));
        expect(String(exit)).toContain("was merged before the issue was sent back or reopened");
        expect(writes).toEqual([]);
      }),
  );

  it.effect("does not settle an issue reopened on the board against an older merge", () =>
    Effect.gen(function* () {
      // No sent-back comment: the board's Reopen only leaves a reopen event on the timeline.
      const { feed, writes } = yield* makeHarness({
        pulls: [closingPull({ merged: true, mergedAt: "2026-10-05T00:00:00.000Z" })],
        timeline: [
          { type: "close", created_at: "2026-10-05T00:00:01.000Z" },
          { type: "reopen", created_at: "2026-10-06T00:00:00.000Z" },
        ],
      });
      const exit = yield* Effect.exit(feed.approveAndMerge({ threadId: ROOT, reference: "7" }));
      expect(String(exit)).toContain("was merged before the issue was sent back or reopened");
      expect(writes).toEqual([]);
    }),
  );

  it.effect("pins the merge to the commit the card showed", () =>
    Effect.gen(function* () {
      const { feed, writes } = yield* makeHarness({ pulls: [closingPull()] });
      yield* feed.approveAndMerge({ threadId: ROOT, reference: "7", headSha: "shown-sha" });
      expect(writes.find((write) => write.path.endsWith("/merge"))?.body).toEqual({
        Do: "merge",
        head_commit_id: "shown-sha",
      });
    }),
  );

  it.effect("leaves a long-closed issue alone when its pull request was merged elsewhere", () =>
    Effect.gen(function* () {
      const { feed, writes, commands } = yield* makeHarness({
        pulls: [closingPull({ merged: true, mergedAt: "2026-10-06T00:00:00.000Z" })],
        issueState: "closed",
      });
      yield* TestClock.setTime(Date.parse("2026-10-08T05:00:00.000Z"));
      const result = yield* feed.approveAndMerge({ threadId: ROOT, reference: "7" });
      expect(result).toMatchObject({ alreadyMerged: true, notifiedThreadId: null });
      expect(writes).toEqual([]);
      expect(commands).toEqual([]);
    }),
  );

  it.effect("two approvals of different issues do not wait for each other", () =>
    Effect.gen(function* () {
      const { feed, control } = yield* makeHarness({
        pulls: [closingPull(), closingPull({ number: 196, body: "Closes #4" })],
      });
      const reached = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      control.gate = { reached, release };
      const slow = yield* Effect.forkChild(
        feed.approveAndMerge({ threadId: ROOT, reference: "7" }),
      );
      yield* Deferred.await(reached);
      // Issue 4's own approval completes while issue 7's merge is still held open.
      control.gate = null;
      const other = yield* feed.approveAndMerge({ threadId: ROOT, reference: "4" });
      expect(other.pullRequest.number).toBe(196);
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(slow);
    }),
  );

  it.effect("settles against a merge that came after the issue was sent back", () =>
    Effect.gen(function* () {
      const { feed } = yield* makeHarness({
        pulls: [closingPull({ merged: true, mergedAt: "2026-10-07T00:00:00.000Z" })],
        comments: [
          {
            body: "Brad sent this back:\n\nBroken on the phone",
            created_at: "2026-10-06T00:00:00.000Z",
          },
        ],
      });
      const result = yield* feed.approveAndMerge({ threadId: ROOT, reference: "7" });
      expect(result.alreadyMerged).toBe(true);
    }),
  );

  it.effect("still posts the approval note when Gitea had already closed the issue", () =>
    Effect.gen(function* () {
      const { feed, writes } = yield* makeHarness({
        pulls: [closingPull({ merged: true })],
        issueState: "closed",
      });
      const result = yield* feed.approveAndMerge({ threadId: ROOT, reference: "7" });
      expect(result.alreadyMerged).toBe(true);
      expect(writes.map((write) => `${write.method} ${write.path}`)).toEqual([
        `POST /repos/${REPO}/issues/7/comments`,
      ]);
    }),
  );

  it.effect("refuses a pull request whose mergeability is not known yet", () =>
    Effect.gen(function* () {
      const { feed, writes } = yield* makeHarness({
        pulls: [{ number: 195, title: "fix", body: "Closes #7" }],
      });
      const exit = yield* Effect.exit(feed.approveAndMerge({ threadId: ROOT, reference: "7" }));
      expect(String(exit)).toContain("has not said whether PR 195 can merge");
      expect(writes).toEqual([]);
    }),
  );

  it.effect("refuses a conflicting pull request without merging or settling anything", () =>
    Effect.gen(function* () {
      const { feed, writes, commands } = yield* makeHarness({
        pulls: [closingPull({ mergeable: false })],
      });
      const exit = yield* Effect.exit(
        feed.approveAndMerge({ threadId: ROOT, reference: `${REPO}#7` }),
      );

      expect(Exit.isFailure(exit)).toBe(true);
      expect(String(exit)).toContain("PR 195 is not mergeable into main");
      expect(writes).toEqual([]);
      expect(commands).toEqual([]);
    }),
  );

  it.effect("refuses a draft, and a pull request that does not close the issue", () =>
    Effect.gen(function* () {
      const draft = yield* makeHarness({ pulls: [closingPull({ draft: true })] });
      const draftExit = yield* Effect.exit(
        draft.feed.approveAndMerge({ threadId: ROOT, reference: "7" }),
      );
      expect(String(draftExit)).toContain("PR 195 is a draft");
      expect(mergeCalls(draft.writes)).toEqual([]);

      const unrelated = yield* makeHarness({ pulls: [closingPull({ body: "See #70" })] });
      const unrelatedExit = yield* Effect.exit(
        unrelated.feed.approveAndMerge({ threadId: ROOT, reference: "7" }),
      );
      expect(String(unrelatedExit)).toContain("No open pull request closes #7");
      expect(unrelated.writes).toEqual([]);
    }),
  );

  it.effect("asks for a choice instead of merging when two pull requests close the issue", () =>
    Effect.gen(function* () {
      const { feed, writes } = yield* makeHarness({
        pulls: [closingPull(), closingPull({ number: 196 })],
      });
      const ambiguous = yield* Effect.exit(
        feed.approveAndMerge({ threadId: ROOT, reference: "7" }),
      );
      expect(String(ambiguous)).toContain("PR 195, PR 196");
      expect(writes).toEqual([]);

      yield* feed.approveAndMerge({ threadId: ROOT, reference: "7", pullRequest: 196 });
      expect(mergeCalls(writes).map((write) => write.path)).toEqual([
        `/repos/${REPO}/pulls/196/merge`,
      ]);
    }),
  );

  it.effect("reports Gitea's own refusal and leaves the issue open", () =>
    Effect.gen(function* () {
      const { feed, writes } = yield* makeHarness({ pulls: [closingPull()], mergeStatus: 405 });
      const exit = yield* Effect.exit(feed.approveAndMerge({ threadId: ROOT, reference: "7" }));
      expect(String(exit)).toContain("Gitea refused to merge PR 195");
      expect(writes.map((write) => write.method)).toEqual(["POST"]);
    }),
  );
});

describe("Send back", () => {
  it.effect("comments the note, returns the issue to in progress and tells the worker", () =>
    Effect.gen(function* () {
      const { feed, writes, commands } = yield* makeHarness({});
      const result = yield* feed.sendBack({
        threadId: ROOT,
        reference: `${REPO}#7`,
        note: "Rebase onto main first.",
      });

      expect(result).toEqual({ notifiedThreadId: WORKER, viaOrchestrator: false });
      const comment = writes.find((write) => write.path.endsWith("/issues/7/comments"));
      expect(comment?.body).toEqual({ body: "Brad sent this back:\n\nRebase onto main first." });
      // An open issue is not reopened; needs-review comes off as it moves to in progress.
      expect(writes.some((write) => write.method === "PATCH")).toBe(false);
      expect(writes).toContainEqual({
        method: "DELETE",
        path: `/repos/${REPO}/issues/7/labels/3`,
        body: null,
      });
      expect(writes).toContainEqual({
        method: "POST",
        path: `/repos/${REPO}/issues/7/labels`,
        body: { labels: [4] },
      });
      const [message] = messages(commands);
      expect(message?.threadId).toBe(WORKER);
      expect(message?.text).toContain("Rebase onto main first.");
    }),
  );

  it.effect("reaches the orchestrator when the owning worker is archived", () =>
    Effect.gen(function* () {
      const threads = baseThreads.map((shell) =>
        shell.id === WORKER ? { ...shell, archivedAt: NOW } : shell,
      );
      const { feed, commands } = yield* makeHarness({ threads });
      const result = yield* feed.sendBack({ threadId: ROOT, reference: "7", note: "Redo it" });
      expect(result).toEqual({ notifiedThreadId: ROOT, viaOrchestrator: true });
      expect(messages(commands)[0]?.threadId).toBe(ROOT);
    }),
  );

  it.effect("reopens a closed issue before moving it back", () =>
    Effect.gen(function* () {
      const { feed, writes } = yield* makeHarness({ issueState: "closed" });
      yield* feed.sendBack({ threadId: ROOT, reference: "7", note: "Broken on the phone" });
      expect(writes[0]).toMatchObject({
        method: "PATCH",
        path: `/repos/${REPO}/issues/7`,
        body: { state: "open" },
      });
    }),
  );

  it.effect("refuses an empty note", () =>
    Effect.gen(function* () {
      const { feed, writes } = yield* makeHarness({});
      const exit = yield* Effect.exit(
        feed.sendBack({ threadId: ROOT, reference: "7", note: "  \n " }),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      expect(writes).toEqual([]);
    }),
  );
});

describe("Later", () => {
  it.effect("records the time on the issue and tells nobody", () =>
    Effect.gen(function* () {
      const { feed, writes, commands } = yield* makeHarness({});
      const until = "2099-01-01T00:00:00.000Z";
      const result = yield* feed.defer({
        threadId: ROOT,
        reference: `${REPO}#4`,
        mode: "until",
        until,
      });

      expect(result).toEqual({ until, movedToEndAt: null });
      expect(writes).toHaveLength(1);
      expect(writes[0]).toMatchObject({ method: "PATCH", path: `/repos/${REPO}/issues/4` });
      const body = (writes[0]!.body as { body: string }).body;
      // The marker replaces the earlier one and the decision text is untouched.
      expect(body.match(/t3-deferral/g)).toHaveLength(1);
      expect(body).toContain(until);
      expect(body).toContain("Which tool changer set should be printed next?");
      expect(commands).toEqual([]);
    }),
  );

  it.effect("moves to the end, keeps the chosen time, and clear removes both", () =>
    Effect.gen(function* () {
      const { feed, writes } = yield* makeHarness({});
      const moved = yield* feed.defer({ threadId: ROOT, reference: "4", mode: "end" });
      expect(moved.until).toBe("2026-10-07T12:00:00.000Z");
      expect(moved.movedToEndAt).not.toBeNull();

      const cleared = yield* feed.defer({ threadId: ROOT, reference: "4", mode: "clear" });
      expect(cleared).toEqual({ until: null, movedToEndAt: null });
      expect((writes.at(-1)!.body as { body: string }).body).not.toContain("t3-deferral");
    }),
  );

  it.effect("refuses a time that has passed", () =>
    Effect.gen(function* () {
      const { feed, writes } = yield* makeHarness({});
      yield* TestClock.setTime(Date.parse("2026-10-08T05:00:00.000Z"));
      const exit = yield* Effect.exit(
        feed.defer({
          threadId: ROOT,
          reference: "4",
          mode: "until",
          until: "2026-10-08T04:59:00.000Z",
        }),
      );
      expect(String(exit)).toContain("Pick a time in the future");
      expect(writes).toEqual([]);
    }),
  );
});

describe("the issue list", () => {
  it.effect("names the owner, project, deadline and Later on a decision", () =>
    Effect.gen(function* () {
      const { projectIssues, feed } = yield* makeHarness({});
      const listed = yield* projectIssues.list({ rootThreadId: ROOT });
      const enriched = yield* feed.enrich(listed, ROOT);
      const decision = enriched.issues.find((issue) => issue.number === 4);
      const review = enriched.issues.find((issue) => issue.number === 7);

      expect(decision?.decision?.deadline).toBe("2026-10-08");
      expect(decision?.deferral).toEqual({
        until: "2026-10-07T12:00:00.000Z",
        movedToEndAt: null,
      });
      expect(decision?.owner).toEqual({
        threadId: OWNER,
        title: "End Effector Orchestrator",
        projectTitle: "Printcell",
      });
      // The review card is for the worker linked to it.
      expect(review?.owner).toMatchObject({ threadId: WORKER, title: "Gripper worker" });
      expect(review?.deferral).toBeUndefined();
    }),
  );

  it.effect("names the archived worker when the orchestrator stands in for it", () =>
    Effect.gen(function* () {
      const threads = baseThreads.map((shell) =>
        shell.id === WORKER ? { ...shell, archivedAt: NOW } : shell,
      );
      const { projectIssues, feed } = yield* makeHarness({ threads });
      const enriched = yield* feed.enrich(yield* projectIssues.list({ rootThreadId: ROOT }), ROOT);
      expect(enriched.issues.find((issue) => issue.number === 7)?.owner).toEqual({
        threadId: ROOT,
        title: "T3 Orchestrator",
        projectTitle: "Printcell",
        previousTitle: "Gripper worker",
      });
    }),
  );
});

describe("pending asks", () => {
  it.effect("reads the question text of the thread that is waiting, and of no other", () =>
    Effect.gen(function* () {
      const threads = baseThreads.map((shell) =>
        shell.id === OWNER ? { ...shell, pending: "user_input" as const } : shell,
      );
      const { feed, sql } = yield* makeHarness({ threads });
      yield* insertRequest(sql, { id: "r1", thread: OWNER, status: "pending", at: AT });
      yield* insertQuestion(sql, OWNER, "r1", 3);

      const { asks } = yield* feed.pendingAsks({ threadId: WORKER });
      expect(
        asks.map((ask) => [ask.kind, ask.threadId, ask.threadTitle, ask.projectTitle]),
      ).toEqual([["question", OWNER, "End Effector Orchestrator", "Printcell"]]);
      const question = asks[0];
      expect(question?.kind === "question" && question.questions[0]?.question).toBe(
        "Did the timer stop, and did you then hear the reminder?",
      );
    }),
  );

  it.effect("is empty when no thread waits, and when a flagged thread has nothing to show", () =>
    Effect.gen(function* () {
      const quiet = yield* makeHarness({});
      expect(yield* quiet.feed.pendingAsks({ threadId: ROOT })).toEqual({ asks: [] });

      const flagged = yield* makeHarness({
        threads: baseThreads.map((shell) =>
          shell.id === OWNER ? { ...shell, pending: "command" as const } : shell,
        ),
      });
      expect(yield* flagged.feed.pendingAsks({ threadId: ROOT })).toEqual({ asks: [] });
    }),
  );
});
