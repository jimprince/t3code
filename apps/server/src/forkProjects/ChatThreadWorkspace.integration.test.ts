import { assert, it } from "@effect/vitest";
import {
  CommandId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Result from "effect/Result";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import { layerMemory as SqlitePersistenceMemory } from "../persistence/Sqlite.ts";
import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import type { ProviderAdapterV2 } from "@t3tools/provider-core/server/ProviderAdapter";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import { layerWithRegistry as makeOrchestratorV2ReplayLayerWithRegistry } from "../orchestration-v2/testkit/ProviderReplayHarness.ts";

const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "gpt-5.1-codex" };
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("No provider process needed for metadata controls"),
} as ProviderAdapterV2["Service"];
const database = SqlitePersistenceMemory;
const testLayer = Layer.mergeAll(
  database,
  ProjectionStore.layer.pipe(Layer.provide(database)),
  makeOrchestratorV2ReplayLayerWithRegistry(
    { name: "control-reads" },
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
    { databaseLayer: database, runEffectWorker: false },
  ),
);

import { writeProjectKind } from "./ProjectKinds.ts";

it.effect("native thread create and metadata commands retain General Chat workspace guards", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const sql = yield* SqlClient.SqlClient;
    const projectId = ProjectId.make("chat-command-guard");
    yield* writeProjectKind(sql, projectId, "chat");
    yield* sql`INSERT INTO projection_projects (project_id, title, workspace_root, default_model_selection_json, scripts_json, created_at, updated_at, deleted_at)
      VALUES (${projectId}, 'Chat', '/tmp/chat-command-guard', NULL, '[]', '2026-10-05T00:00:00.000Z', '2026-10-05T00:00:00.000Z', NULL)`;
    const create = (id: string, worktreePath: string | null) => ({
      type: "thread.create" as const,
      commandId: CommandId.make(`create-${id}`),
      threadId: ThreadId.make(id),
      projectId,
      title: "Chat",
      modelSelection,
      runtimeMode: "full-access" as const,
      interactionMode: "default" as const,
      branch: null,
      worktreePath,
      createdBy: "user" as const,
      creationSource: "web" as const,
    });
    assert.equal(
      Result.isFailure(
        yield* Effect.result(orchestrator.dispatch(create("forbidden-chat", "/tmp/other"))),
      ),
      true,
    );
    const threadId = ThreadId.make("allowed-chat");
    yield* orchestrator.dispatch(create(threadId, null));
    assert.equal(
      Result.isFailure(
        yield* Effect.result(
          orchestrator.dispatch({
            type: "thread.metadata.update",
            commandId: CommandId.make("forbidden-metadata"),
            threadId,
            worktreePath: "/tmp/other",
          }),
        ),
      ),
      true,
    );
    yield* orchestrator.dispatch({
      type: "thread.metadata.update",
      commandId: CommandId.make("allowed-metadata"),
      threadId,
      title: "Conversation renamed",
    });
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const thread = yield* projections.getThreadShell(threadId);
    assert.equal(thread?.title, "Conversation renamed");
    assert.equal(thread?.worktreePath, null);
  }).pipe(Effect.provide(testLayer)),
);
