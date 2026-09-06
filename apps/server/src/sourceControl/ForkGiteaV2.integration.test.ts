import { assert, it } from "@effect/vitest";
import {
  CommandId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import type { ProviderAdapterV2Shape } from "../orchestration-v2/ProviderAdapter.ts";
import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import { makeOrchestratorV2ReplayLayerWithRegistry } from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import * as Schema from "effect/Schema";

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const instanceId = ProviderInstanceId.make("codex");
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("PR metadata never starts a provider"),
} as ProviderAdapterV2Shape;
const database = SqlitePersistenceMemory;
const layer = Layer.mergeAll(
  database,
  ProjectionStore.layer.pipe(Layer.provide(database)),
  makeOrchestratorV2ReplayLayerWithRegistry(
    { name: "fork-gitea-persistence" },
    ProviderAdapterRegistry.makeLayer([adapter]),
    { databaseLayer: database, runEffectWorker: false },
  ),
);

it.effect(
  "persists canonical Gitea URL repair without losing sibling PRs and dispatches idempotently",
  () =>
    Effect.gen(function* () {
      const engine = yield* Orchestrator.OrchestratorV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const sql = yield* SqlClient.SqlClient;
      const threadId = ThreadId.make("gitea-url-repair");
      yield* engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make("create"),
        threadId,
        projectId: ProjectId.make("thread-project"),
        title: "Gitea",
        modelSelection: { instanceId, model: "gpt-6.1-sol" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdBy: "user",
        creationSource: "web",
      });
      const host = "git.example.test";
      const repository = "brad/target";
      for (const number of [41, 42])
        yield* engine.dispatch({
          type: "thread.pull-request.link",
          commandId: CommandId.make(`link-${number}`),
          threadId,
          host,
          repository,
          number,
          url: `https://api.example.test/${repository}/pull/${number}`,
          source: "agent",
        });
      yield* engine.dispatch({
        type: "thread.pull-request.link",
        commandId: CommandId.make("link-other-host"),
        threadId,
        host: "other.example.test",
        repository,
        number: 42,
        url: `https://other.example.test/${repository}/pulls/42`,
        source: "agent",
      });
      // Seed the imported compatibility pointer with the same stale origin as the
      // explicit persisted link, whose target host is authoritative.
      const legacy = {
        projectId: ProjectId.make("target-project"),
        repository,
        number: 42,
        url: `https://api.example.test/${repository}/pull/42`,
      };
      yield* sql`UPDATE orchestration_v2_projection_threads
        SET payload_json = json_set(payload_json, '$.linkedPullRequest', json(${encodeJson(legacy)}))
        WHERE thread_id = ${threadId}`;
      const url = `https://${host}/${repository}/pulls/42`;
      const sync = {
        type: "thread.pull-request-link.sync" as const,
        commandId: CommandId.make("repair"),
        threadId,
        host,
        repository,
        number: 42,
        url,
        stack: null,
        snapshot: {
          state: "merged" as const,
          title: "Target",
          headBranch: "feature",
          baseBranch: "main",
          isDraft: false,
          updatedAt: null,
          closedAt: null,
          mergedAt: "2026-10-05T00:00:00Z",
          syncedAt: "2026-10-05T00:00:00Z",
        },
      };
      yield* engine.dispatch(sync);
      yield* engine.dispatch(sync);
      const saved = yield* projections.getThreadProjection(threadId);
      assert.deepEqual(
        saved.thread.pullRequests?.map((pr) => pr.number),
        [41, 42, 42],
      );
      assert.equal(saved.thread.pullRequests?.[1]?.url, url);
      assert.equal(saved.thread.linkedPullRequest?.url, url);
      assert.equal(saved.thread.pullRequests?.[1]?.snapshot?.state, "merged");
      assert.equal(saved.thread.pullRequests?.[0]?.snapshot, null);
      assert.equal(saved.thread.pullRequests?.[2]?.snapshot, null);
      assert.equal(
        saved.thread.pullRequests?.[2]?.url,
        `https://other.example.test/${repository}/pulls/42`,
      );
      assert.equal(saved.thread.linkedPullRequest?.projectId, "target-project");
    }).pipe(Effect.provide(layer)),
);
