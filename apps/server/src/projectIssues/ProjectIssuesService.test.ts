import { describe, expect } from "vite-plus/test";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Layer from "effect/Layer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { HttpClient, HttpClientResponse } from "effect/http";
import { ThreadId, type GiteaInstanceConfig } from "@t3tools/contracts";
import { ServerSettingsService } from "../serverSettings.ts";
import { ThreadManagementService } from "../orchestration-v2/ThreadManagementService.ts";
import { ProjectService } from "../project/ProjectService.ts";
import * as SqlClient from "effect/sql/SqlClient";
import { make } from "./ProjectIssuesService.ts";

describe("project issue metadata refresh", () => {
  it.effect("refreshes persisted thread badges from board reads through the configured API", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("root");
      const now = "2026-10-05T00:00:00.000Z";
      const instance: GiteaInstanceConfig = {
        id: "home",
        host: "git.home",
        sshAliases: [],
        sshPorts: [2222],
        webOrigin: "http://git.home:3000",
        apiOrigin: "http://git.home:3000",
        token: "test",
      };
      const link = {
        host: "git.home:3000",
        repository: "brad/t3code-fork",
        number: 73,
        url: "https://git.bradleyprince.com/brad/t3code-fork/issues/73",
        linkedAt: now,
        snapshot: { title: "brad/t3code-fork #73", state: "open", syncedAt: now },
      };
      const thread = { id: threadId, projectId: "project", issues: [link] };
      const project = {
        id: "project",
        workspaceRoot: "/repo",
        repositoryIdentity: {
          provider: "gitea",
          canonicalKey: "git.bradleyprince.com/brad/t3code-fork",
          locator: { remoteUrl: "ssh://git@git.home:2222/brad/t3code-fork.git" },
        },
      };
      const commands: unknown[] = [];
      const urls: string[] = [];
      const result = yield* make.pipe(
        Effect.flatMap((service) => service.list({ rootThreadId: threadId })),
        Effect.provideService(SqlClient.SqlClient, ((_strings: TemplateStringsArray) =>
          Effect.succeed([])) as never),
        Effect.provideService(ProjectService, {
          getShell: () => Effect.succeed(Option.some(project)),
          listShells: () => Effect.succeed([project]),
        } as never),
        Effect.provideService(ThreadManagementService, {
          getShellSnapshot: () => Effect.succeed({ threads: [thread], archivedThreads: [] }),
          getThreadShell: () => Effect.succeed(thread),
          dispatch: (command: unknown) => {
            commands.push(command);
            return Effect.succeed({});
          },
        } as never),
        Effect.provideService(
          HttpClient.HttpClient,
          HttpClient.make((request) => {
            urls.push(request.url);
            const issues = request.url.includes("state=closed")
              ? [
                  {
                    number: 73,
                    title: "Fixed title",
                    state: "closed",
                    html_url: link.url,
                    created_at: now,
                    updated_at: now,
                    pull_request: null,
                  },
                ]
              : [];
            return Effect.succeed(
              HttpClientResponse.fromWeb(request, new Response(JSON.stringify(issues))),
            );
          }),
        ),
        Effect.provide(
          Layer.mergeAll(
            NodeServices.layer,
            ServerSettingsService.layerTest({ giteaInstances: [instance] }),
          ),
        ),
      );
      expect(result.issues).toMatchObject([
        { title: "Fixed title", status: "done", linkedThreadIds: [threadId] },
      ]);
      expect(commands).toMatchObject([
        {
          type: "thread.issue.sync",
          url: link.url,
          snapshot: { title: "Fixed title", state: "closed" },
        },
      ]);
      expect(urls.every((url) => url.startsWith("http://git.home:3000/api/v1/"))).toBe(true);
    }),
  );
});
