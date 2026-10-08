import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { CommandId, ProjectId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { vi } from "vite-plus/test";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { assertFixtureMigration16 } from "../persistence/fixtureMigration16.testkit.ts";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerConfig from "../config.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import { layerProjectService as ProjectServiceLayerLive } from "../orchestration-v2/runtimeLayer.ts";
import { layerMemory as SqlitePersistenceMemory } from "../persistence/Sqlite.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import * as ProjectEnrichmentService from "../project/ProjectEnrichmentService.ts";
import * as ProjectFaviconResolver from "../project/ProjectFaviconResolver.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";

const workspacePathsLayer = Layer.succeed(WorkspacePaths.WorkspacePaths, {
  normalizeWorkspaceRoot: (workspaceRoot) => Effect.succeed(workspaceRoot.replace(/\/$/, "")),
  resolveRelativePathWithinRoot: ({ workspaceRoot, relativePath }) =>
    Effect.succeed({ absolutePath: `${workspaceRoot}/${relativePath}`, relativePath }),
});

const metadataLayer = Layer.merge(
  Layer.succeed(RepositoryIdentityResolver.RepositoryIdentityResolver, {
    resolve: (workspaceRoot) =>
      Effect.succeed({
        canonicalKey: `github.com/t3tools/${workspaceRoot.split("/").at(-1)}`,
        locator: {
          source: "git-remote" as const,
          remoteName: "origin",
          remoteUrl: `git@github.com:t3tools/${workspaceRoot.split("/").at(-1)}.git`,
        },
        rootPath: workspaceRoot,
      }),
  }),
  Layer.succeed(ProjectFaviconResolver.ProjectFaviconResolver, {
    resolvePath: (workspaceRoot) => Effect.succeed(`${workspaceRoot}/favicon.svg`),
  }),
);

const makeTestLayer = (
  projectMetadataLayer: Layer.Layer<
    | ProjectFaviconResolver.ProjectFaviconResolver
    | RepositoryIdentityResolver.RepositoryIdentityResolver
  >,
  databaseLayer = SqlitePersistenceMemory,
  pathsLayer: Layer.Layer<
    WorkspacePaths.WorkspacePaths,
    never,
    FileSystem.FileSystem | Path.Path
  > = workspacePathsLayer,
) =>
  ProjectServiceLayerLive.pipe(
    Layer.provideMerge(ProjectEnrichmentService.layer),
    Layer.provideMerge(pathsLayer),
    Layer.provideMerge(projectMetadataLayer),
    Layer.provideMerge(databaseLayer),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "project-service-test-" })),
    Layer.provideMerge(NodeServices.layer),
  );

const TestLayer = makeTestLayer(metadataLayer);

import { ensureGeneralChat, getChatProjectId } from "./GeneralChatService.ts";
import { initializeProjectKinds } from "./ProjectKinds.ts";
import migration036 from "../persistence/Migrations/036_ProjectionProjectsKind.ts";
import migration037 from "../persistence/Migrations/037_UniqueProjectCreation.ts";

it.effect("concurrent startup and restart preserve one General Chat beside Scratch", () =>
  Effect.gen(function* () {
    const projects = yield* ProjectService.ProjectService;
    const ids = yield* Effect.all(
      [ensureGeneralChat("environment-chat"), ensureGeneralChat("environment-chat")],
      { concurrency: "unbounded" },
    );
    assert.deepStrictEqual(ids, [
      getChatProjectId("environment-chat"),
      getChatProjectId("environment-chat"),
    ]);
    assert.equal(yield* ensureGeneralChat("environment-chat"), ids[0]);
    const scratch = yield* projects.create({
      commandId: CommandId.make("scratch-create"),
      projectId: ProjectId.make("scratch"),
      title: "Scratch",
      workspaceRoot: "/tmp/scratch",
    });
    assert.equal(scratch.kind, "workspace");
    const shells = yield* projects.listShells();
    assert.equal(shells.filter((project) => project.kind === "chat").length, 1);
    const chat = shells.find((project) => project.kind === "chat")!;
    assert.equal(chat.repositoryIdentity, null);
    assert.equal(chat.id, ids[0]);
    const sql = yield* SqlClient.SqlClient;
    const events = yield* sql<{
      count: number;
    }>`SELECT count(*) AS count FROM orchestration_events WHERE stream_id = ${chat.id} AND event_type = 'project.created'`;
    assert.equal(events[0]?.count, 1);
  }).pipe(Effect.provide(TestLayer)),
);

it.effect("chat project identity and workspace guards apply through the V2 service", () =>
  Effect.gen(function* () {
    const id = yield* ensureGeneralChat("guard-environment");
    const projects = yield* ProjectService.ProjectService;
    for (const update of [
      { title: "Hijacked" },
      { workspaceRoot: "/tmp/elsewhere" },
      { scripts: [] },
      { defaultModelSelection: null },
    ]) {
      const result = yield* Effect.result(
        projects.update({
          commandId: CommandId.make(`guard-${Object.keys(update)[0]}`),
          projectId: id,
          ...update,
        }),
      );
      assert.equal(Result.isFailure(result), true);
    }
    assert.equal(
      Result.isFailure(
        yield* Effect.result(
          projects.delete({ commandId: CommandId.make("delete-chat"), projectId: id, force: true }),
        ),
      ),
      true,
    );
    const unchanged = yield* projects.update({
      commandId: CommandId.make("chat-undefined-metadata"),
      projectId: id,
      title: undefined,
      workspaceRoot: undefined,
      scripts: undefined,
      defaultModelSelection: undefined,
    });
    assert.equal(unchanged.id, id);
    assert.equal(Option.isSome(yield* projects.getShell(id)), true);
  }).pipe(Effect.provide(TestLayer)),
);

it.effect(
  "036/037 kind import is idempotent and preserves original IDs through store restart",
  () =>
    Effect.gen(function* () {
      const projects = yield* ProjectService.ProjectService;
      const projectId = ProjectId.make("original-chat-id");
      yield* projects.create({
        commandId: CommandId.make("legacy-create"),
        projectId,
        title: "Chat",
        workspaceRoot: "/tmp/original-chat",
      });
      const sql = yield* SqlClient.SqlClient;
      yield* migration036;
      yield* migration037;
      yield* sql`UPDATE projection_projects SET kind = 'chat' WHERE project_id = ${projectId}`;
      yield* sql`DELETE FROM fork_project_kinds WHERE project_id = ${projectId}`;
      yield* initializeProjectKinds(sql);
      yield* initializeProjectKinds(sql);
      const restarted = yield* ProjectStore.make;
      const shell = yield* restarted.getShell(projectId);
      assert.equal(Option.isSome(shell) && shell.value.kind, "chat");
      assert.equal(Option.isSome(shell) && shell.value.id, projectId);
      const records = yield* sql<{
        count: number;
      }>`SELECT count(*) AS count FROM fork_project_kinds WHERE project_id = ${projectId}`;
      assert.equal(records[0]?.count, 1);
    }).pipe(Effect.provide(TestLayer)),
);

it.effect("new chat workspaces stay under T3 home when TMPDIR changes", () =>
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const projects = yield* ProjectService.ProjectService;
    const id = yield* ensureGeneralChat("stable-home");
    const chat = Option.getOrThrow(yield* projects.getById(id));
    assert.equal(path.dirname(chat.workspaceRoot), path.join(config.baseDir, "chat-workspaces"));
    yield* fs.writeFileString(path.join(chat.workspaceRoot, "retained.txt"), "chat files");
    yield* fs.makeDirectory(path.join(config.baseDir, "changed-tmp"));
    yield* Effect.acquireRelease(
      Effect.sync(() => vi.stubEnv("TMPDIR", path.join(config.baseDir, "changed-tmp"))),
      () => Effect.sync(() => vi.unstubAllEnvs()),
    );
    assert.equal(yield* ensureGeneralChat("stable-home"), id);
    assert.equal(
      yield* fs.readFileString(path.join(chat.workspaceRoot, "retained.txt")),
      "chat files",
    );
    assert.equal(Option.getOrThrow(yield* projects.getById(id)).workspaceRoot, chat.workspaceRoot);
  }).pipe(
    Effect.scoped,
    Effect.provide(makeTestLayer(metadataLayer, SqlitePersistenceMemory, WorkspacePaths.layer)),
  ),
);

const fixtures = process.env.T3_LIFECYCLE_FIXTURES;
for (const host of ["dev-vm", "local-mbp"]) {
  it.effect.skipIf(!fixtures)(
    `copied ${host} chat threads retain their workspace across restart`,
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const temporary = yield* fs.makeTempDirectoryScoped({ prefix: "chat-startup-" });
          const copy = path.join(temporary, "state.sqlite");
          yield* fs.copyFile(path.join(fixtures!, `${host}.small.sanitized.sqlite`), copy);
          const database = NodeSqliteClient.layer({ filename: copy });
          const environmentId = `copied-${host}`;
          const projectId = getChatProjectId(environmentId);
          // Sanitized fixtures remap environment/project IDs and machine paths. Rebind only
          // this disposable copy to a test environment and a sandboxed legacy TMPDIR.
          const legacyRoot = path.join(
            temporary,
            "old-tmp",
            "t3code-chat-workspaces",
            String(projectId).slice(5),
          );
          yield* Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            yield* assertFixtureMigration16;
            const [original] = yield* sql<{
              project_id: string;
            }>`SELECT project_id FROM projection_projects WHERE kind='chat'`;
            assert.isDefined(original);
            yield* sql`UPDATE projection_threads SET project_id=${projectId} WHERE project_id=${original!.project_id}`;
            yield* sql`UPDATE projection_projects SET project_id=${projectId}, workspace_root=${legacyRoot} WHERE project_id=${original!.project_id}`;
            // Pre-sanitizer provider IDs are not valid ProviderInstanceIds (fixture README).
            yield* sql`UPDATE projection_projects SET default_model_selection_json=json_set(default_model_selection_json,'$.instanceId','codex') WHERE default_model_selection_json IS NOT NULL`;
            const threadsBefore =
              yield* sql`SELECT * FROM projection_threads WHERE project_id=${projectId} ORDER BY thread_id`;
            const messagesBefore =
              yield* sql`SELECT * FROM projection_thread_messages WHERE thread_id IN (SELECT thread_id FROM projection_threads WHERE project_id=${projectId}) ORDER BY message_id`;
            assert.isAbove(threadsBefore.length, 0);
            const projectsBefore =
              yield* sql`SELECT * FROM projection_projects ORDER BY project_id`;
            const ledgersBefore =
              yield* sql`SELECT * FROM effect_sql_fork_migrations ORDER BY migration_id`;
            const restart = Effect.gen(function* () {
              const projects = yield* ProjectService.ProjectService;
              assert.equal(yield* ensureGeneralChat(environmentId), projectId);
              const chat = Option.getOrThrow(yield* projects.getById(projectId));
              assert.equal(chat.kind, "chat");
              assert.equal(chat.workspaceRoot, legacyRoot);
              assert.equal((yield* fs.stat(legacyRoot)).type, "Directory");
              assert.equal(
                (yield* projects.listShells()).filter((project) => project.kind === "chat").length,
                1,
              );
            });
            yield* fs.makeDirectory(path.join(temporary, "new-tmp"));
            yield* Effect.acquireRelease(
              Effect.sync(() => vi.stubEnv("TMPDIR", path.join(temporary, "new-tmp"))),
              () => Effect.sync(() => vi.unstubAllEnvs()),
            );
            // Each provision builds a fresh production ProjectService/ProjectStore.
            for (let pass = 0; pass < 2; pass++) {
              yield* restart.pipe(
                Effect.provide(makeTestLayer(metadataLayer, database, WorkspacePaths.layer)),
              );
              const retainedFile = path.join(legacyRoot, "retained.txt");
              if (pass === 0) yield* fs.writeFileString(retainedFile, "existing chat files");
              else assert.equal(yield* fs.readFileString(retainedFile), "existing chat files");
            }
            assert.deepEqual(
              yield* sql`SELECT * FROM projection_projects ORDER BY project_id`,
              projectsBefore,
            );
            assert.deepEqual(
              yield* sql`SELECT * FROM projection_threads WHERE project_id=${projectId} ORDER BY thread_id`,
              threadsBefore,
            );
            assert.deepEqual(
              yield* sql`SELECT * FROM projection_thread_messages WHERE thread_id IN (SELECT thread_id FROM projection_threads WHERE project_id=${projectId}) ORDER BY message_id`,
              messagesBefore,
            );
            assert.deepEqual(
              yield* sql`SELECT * FROM effect_sql_fork_migrations ORDER BY migration_id`,
              ledgersBefore,
            );
          }).pipe(Effect.provide(database));
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
  );
}

it.effect("startup rejects a non-chat project using the server chat identity", () =>
  Effect.gen(function* () {
    const projects = yield* ProjectService.ProjectService;
    const projectId = getChatProjectId("identity-conflict");
    yield* projects.create({
      commandId: CommandId.make("identity-conflict-create"),
      projectId,
      title: "Workspace",
      workspaceRoot: "/work/identity-conflict",
    });
    const error = yield* ensureGeneralChat("identity-conflict").pipe(Effect.flip);
    assert.equal(error._tag, "GeneralChatInvariantError");
    assert.equal(Option.getOrThrow(yield* projects.getById(projectId)).kind, "workspace");
  }).pipe(Effect.provide(TestLayer)),
);
