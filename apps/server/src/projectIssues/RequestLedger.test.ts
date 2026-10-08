import { describe, expect } from "vite-plus/test";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import {
  ProjectIssuesError,
  ThreadId,
  type GiteaInstanceConfig,
  ThreadIssueOperationError,
} from "@t3tools/contracts";
import { ServerConfig } from "../config.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { initializeMetadata } from "../forkThreads/MetadataStore.ts";
import { ThreadManagementService } from "../orchestration-v2/ThreadManagementService.ts";
import { ProjectService } from "../project/ProjectService.ts";
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
) =>
  Effect.gen(function* () {
    yield* initializeMetadata(yield* SqlClient.SqlClient);
    return yield* make({
      projectIssues: {
        trackerForRoot: () => Effect.succeed(null),
        repositoryForProject: () => Effect.succeed(target),
        invalidate: () => undefined,
      } as never,
      threadIssues: { link } as never,
    });
  }).pipe(
    Effect.flatMap(action),
    Effect.provideService(ThreadManagementService, {
      dispatch: dispatch,
      getShellSnapshot: () =>
        Effect.succeed({
          threads: [thread(root, "Chief of staff"), thread(waiting, "Day Planner")],
          archivedThreads: [],
          projects: [{ id: "project", workspaceRoot: "/repo" }],
        }),
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
