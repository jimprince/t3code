import { assert, it } from "@effect/vitest";
import {
  CommandId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type ThreadIssueLink,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as EventStore from "../orchestration-v2/EventStore.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import { makeOrchestratorV2ReplayLayerWithRegistry } from "../orchestration-v2/testkit/ProviderReplayHarness.ts";

const database = SqlitePersistenceMemory;
const runtime = makeOrchestratorV2ReplayLayerWithRegistry(
  { name: "fork-issue-links" },
  ProviderAdapterRegistry.makeLayer([]),
  { databaseLayer: database, runEffectWorker: false },
);
const layer = Layer.merge(
  ThreadManagement.layer.pipe(Layer.provide(runtime)),
  EventStore.layer,
).pipe(Layer.provideMerge(database));

it.effect(
  "issue commands preserve identity, sync cached badges and unlink without resurrecting on receipt replay",
  () =>
    Effect.gen(function* () {
      const management = yield* ThreadManagement.ThreadManagementService;
      const events = yield* EventStore.EventStoreV2;
      const threadId = ThreadId.make("issues-worker");
      yield* management.dispatch({
        type: "thread.create",
        commandId: CommandId.make("issues-create"),
        threadId,
        projectId: ProjectId.make("issues-project"),
        title: "Worker",
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "model" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdBy: "user",
        creationSource: "web",
      });
      const link: ThreadIssueLink = {
        host: "GIT.HOME:3000",
        repository: "Brad/Repo",
        number: 7,
        url: "https://public.example/brad/repo/issues/7",
        linkedAt: "2026-10-06T00:00:00.000Z",
        snapshot: { title: "Original", state: "open", syncedAt: "2026-10-06T00:00:00.000Z" },
      };
      const input = {
        type: "thread.issue.link" as const,
        commandId: CommandId.make("issues-link"),
        threadId,
        link,
      };
      yield* management.dispatch(input);
      yield* management.dispatch(input);
      assert.equal(
        (yield* Effect.exit(
          management.dispatch({ ...input, commandId: CommandId.make("issues-duplicate") }),
        ))._tag,
        "Failure",
      );
      const linked = (yield* management.getThreadShell(threadId))!.issues!;
      assert.equal(linked.length, 1);
      assert.equal(linked[0]!.host, "git.home:3000");
      assert.equal(linked[0]!.repository, "brad/repo");
      assert.equal(linked[0]!.url, link.url);
      assert.equal(
        (yield* Stream.runCollect(events.readByCommandId({ commandId: input.commandId }))).length,
        1,
      );
      yield* management.dispatch({
        type: "thread.issue.sync",
        commandId: CommandId.make("issues-sync"),
        threadId,
        host: link.host,
        repository: link.repository,
        number: link.number,
        url: link.url,
        snapshot: { title: "Updated", state: "closed", syncedAt: "2026-10-06T01:00:00.000Z" },
      });
      const synced = (yield* management.getThreadShell(threadId))!.issues![0]!;
      assert.equal(synced.linkedAt, link.linkedAt);
      assert.equal(synced.snapshot.title, "Updated");
      assert.equal(synced.snapshot.state, "closed");
      yield* management.dispatch({
        type: "thread.issue.link",
        commandId: CommandId.make("issues-link-second"),
        threadId,
        link: { ...link, number: 8 },
      });
      yield* management.dispatch({
        type: "thread.issue.unlink",
        commandId: CommandId.make("issues-unlink"),
        threadId,
        host: link.host,
        repository: link.repository,
        number: 7,
      });
      yield* management.dispatch(input);
      assert.deepStrictEqual(
        (yield* management.getThreadShell(threadId))!.issues!.map((issue) => issue.number),
        [8],
      );
      assert.deepStrictEqual(
        (yield* management.getThreadProjection(threadId)).thread.issues!.map(
          (issue) => issue.number,
        ),
        [8],
      );
      assert.equal(
        (yield* Effect.exit(
          management.dispatch({
            type: "thread.issue.unlink",
            commandId: CommandId.make("issues-missing"),
            threadId,
            host: link.host,
            repository: link.repository,
            number: 7,
          }),
        ))._tag,
        "Failure",
      );
    }).pipe(Effect.provide(layer)),
);
