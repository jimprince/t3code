import { describe, expect } from "vite-plus/test";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import { ProjectIssuesError, ThreadId, type GiteaInstanceConfig } from "@t3tools/contracts";
import { ServerConfig } from "../config.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
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
  updatedAt: "2026-10-06T15:00:00.000Z",
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
          labels: labelled ? [{ name: "needs-brad" }] : [],
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
        return reply(200, [{ id: 7, name: "needs-brad" }]);
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
const answer14 = (
  gitea: ReturnType<typeof fakeGitea>,
  dispatch: (command: { readonly threadId: string }) => Effect.Effect<unknown, ProjectIssuesError>,
) =>
  make({
    projectIssues: {
      repositoryForProject: () => Effect.succeed(target),
      trackerForRoot: () => Effect.succeed(null),
      invalidate: () => undefined,
    } as never,
    threadIssues: {} as never,
    dispatch: dispatch as never,
  }).pipe(
    Effect.flatMap((ledger) =>
      ledger.decide({
        threadId: root,
        reference: "brad/chief-of-staff#14",
        decision: "option",
        option: "Tailnet/LAN only with one password",
      }),
    ),
    Effect.provideService(ProjectionSnapshotQuery, {
      getShellSnapshot: () =>
        Effect.succeed({
          threads: [thread(root, "Chief of staff"), thread(waiting, "Day Planner")],
          projects: [{ id: "project", workspaceRoot: "/repo" }],
        }),
    } as never),
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
