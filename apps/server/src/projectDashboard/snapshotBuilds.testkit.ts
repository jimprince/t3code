import * as NodeServices from "@effect/platform-node/NodeServices";
import { HttpClient, HttpClientResponse } from "effect/http";
import {
  EventId,
  ProjectId,
  ThreadId,
  ProviderInstanceId,
  type GiteaInstanceConfig,
} from "@t3tools/contracts";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Projections from "../orchestration-v2/ProjectionStore.ts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";
import { ServerConfig } from "../config.ts";
import { initializeMetadata, seedCreationMetadata } from "../forkThreads/MetadataStore.ts";
import { ThreadManagementService } from "../orchestration-v2/ThreadManagementService.ts";
import { ProjectService } from "../project/ProjectService.ts";
import { layerMemory } from "../persistence/Sqlite.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import * as Layouts from "../projectLayout/ProjectLayoutService.ts";
import * as Store from "./ProjectDashboardStore.ts";

export const root = ThreadId.make("root");
export const child = ThreadId.make("child");
export const projectId = ProjectId.make("project");
const instance: GiteaInstanceConfig = {
  id: "home",
  host: "git.test",
  sshAliases: [],
  sshPorts: [22],
  webOrigin: "https://git.test",
  apiOrigin: "https://git.test",
  token: "test",
};
const project = { id: projectId, workspaceRoot: "/test/project" };

// Real shell builder, dashboard/layout/ledger/issues services and SQLite;
// substitute the engine command boundary and external Gitea replies.
export const fixture = <A, E, R>(run: (builds: () => number) => Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* initializeMetadata(sql);
    yield* seedCreationMetadata(sql, { threadId: child, parentThreadId: root, subproject: "auto" });
    const projections = yield* Projections.ProjectionStoreV2;
    const now = DateTime.makeUnsafe("2026-10-13T00:00:00Z");
    const instanceId = ProviderInstanceId.make("codex");
    for (const id of [root, child]) {
      yield* projections.apply({
        id: EventId.make(`create:${id}`),
        type: "thread.created",
        threadId: id,
        occurredAt: now,
        payload: {
          id,
          projectId,
          title: id,
          createdBy: "user",
          creationSource: "web",
          providerInstanceId: instanceId,
          modelSelection: { instanceId, model: "gpt-6.1-sol" },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          activeProviderThreadId: null,
          lineage: { rootThreadId: id, parentThreadId: null, relationshipToParent: null },
          forkedFrom: null,
          createdAt: now,
          updatedAt: now,
          archivedAt: null,
          settledAt: null,
          settledOverride: null,
          lastVisitedAt: null,
          deletedAt: null,
        },
      });
    }
    const store = yield* Store.make;
    yield* store.modify((file) => ({ ...file, trackers: { [projectId]: "brad/project" } }));
    let builds = 0;
    return yield* run(() => builds).pipe(
      Effect.provide(Layouts.layer),
      Effect.provideService(ThreadManagementService, {
        getShellSnapshot: () =>
          Effect.sync(() => {
            builds++;
          }).pipe(Effect.andThen(projections.getShellSnapshot())),
        getThreadShell: projections.getThreadShell,
        dispatch: () => Effect.succeed({}),
      } as never),
      Effect.provideService(ProjectService, {
        getShell: () => Effect.succeed(Option.some(project)),
        listShells: () => Effect.succeed([project]),
      } as never),
    );
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Projections.layer.pipe(Layer.provideMerge(layerMemory)),
        ServerSettingsService.layerTest({ giteaInstances: [instance] }),
        ServerConfig.layerTest(process.cwd(), { prefix: "t3-load-builds-" }).pipe(
          Layer.provideMerge(NodeServices.layer),
        ),
      ),
    ),
    Effect.provideService(
      ConfigProvider.ConfigProvider,
      ConfigProvider.fromUnknown({ T3CODE_SHELL_SNAPSHOT_CACHE: "0" }),
    ),
    Effect.provideService(
      HttpClient.HttpClient,
      HttpClient.make((request) =>
        Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            new Response(
              JSON.stringify(
                request.url.includes("/milestones")
                  ? [{ id: 1, title: "Oct 15", state: "open", open_issues: 1, closed_issues: 0 }]
                  : request.url.includes("state=closed")
                    ? []
                    : [
                        {
                          number: 7,
                          title: "Load fixes",
                          body: "",
                          state: "open",
                          labels: [],
                          html_url: "https://git.test/brad/project/issues/7",
                          created_at: "2026-10-13T00:00:00Z",
                          updated_at: "2026-10-13T00:00:00Z",
                          milestone: { id: 1, title: "Oct 15", state: "open" },
                        },
                      ],
              ),
            ),
          ),
        ),
      ),
    ),
  );
