import { assert, it } from "@effect/vitest";
import { CommandId, ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { ForkThreadMetadataUpdate } from "@t3tools/contracts";
import type { ForkThreadMetadata } from "@t3tools/contracts";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import { layerMemory as SqlitePersistenceMemory } from "../persistence/Sqlite.ts";
import * as EventStore from "../orchestration-v2/EventStore.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import { layerWithRegistry as makeOrchestratorV2ReplayLayerWithRegistry } from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import { makeNestingService } from "./NestingService.ts";

class CliTransportError extends Schema.TaggedError<CliTransportError>()("CliTransportError", {
  cause: Schema.Unknown,
}) {}

const decodeCliMetadata = Schema.decodeUnknownSync(ForkThreadMetadataUpdate);
const database = SqlitePersistenceMemory;
const runtime = makeOrchestratorV2ReplayLayerWithRegistry(
  { name: "fork-metadata-shell-refresh" },
  ProviderAdapterRegistry.layerFromAdapters([]),
  { databaseLayer: database, runEffectWorker: false },
);
const layer = Layer.merge(
  ThreadManagement.layer.pipe(Layer.provide(runtime)),
  EventStore.layer,
).pipe(Layer.provideMerge(database));

it.effect(
  "CLI metadata updates publish native shell events; receipts repair interrupted refresh exactly once",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const management = yield* ThreadManagement.ThreadManagementService;
      const events = yield* EventStore.EventStoreV2;
      const parentId = ThreadId.make("refresh-parent");
      const threadId = ThreadId.make("refresh-child");
      for (const id of [parentId, threadId]) {
        yield* management.dispatch({
          type: "thread.create",
          commandId: CommandId.make(`create-${id}`),
          threadId: id,
          projectId: ProjectId.make("refresh-project"),
          title: id,
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "model" },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdBy: "user",
          creationSource: "web",
        });
      }
      const before = (yield* management.getThreadShell(threadId))!;
      const input = {
        commandId: CommandId.make("nest-refresh"),
        threadId,
        parentThreadId: parentId,
      };
      const interrupted = yield* makeNestingService(sql, management.getThreadShell, () =>
        Effect.fail("refresh interrupted"),
      );
      assert.equal((yield* Effect.exit(interrupted.update(input)))._tag, "Failure");
      assert.equal(
        (yield* interrupted.list()).find((row) => row.threadId === threadId)?.parentThreadId,
        parentId,
      );
      const refreshId = CommandId.make("nest-refresh:shell-refresh");
      assert.equal(
        (yield* Stream.runCollect(events.readByCommandId({ commandId: refreshId }))).length,
        0,
      );
      const service = yield* makeNestingService(
        sql,
        management.getThreadShell,
        management.dispatch,
      );
      assert.equal((yield* service.update(input)).parentThreadId, parentId);
      yield* service.update(input);
      const refreshed = yield* Stream.runCollect(events.readByCommandId({ commandId: refreshId }));
      assert.equal(refreshed.length, 1);
      assert.equal(refreshed[0]?.event.type, "thread.metadata-updated");
      const after = (yield* management.getThreadShell(threadId))!;
      assert.equal(before.forkMetadataRevision, undefined);
      assert.equal(after.forkMetadataRevision, 1);
      assert.deepStrictEqual(after.lineage, before.lineage);
      assert.equal(after.projectId, before.projectId);
      assert.equal(after.worktreePath, before.worktreePath);
      assert.deepStrictEqual(after.modelSelection, before.modelSelection);
      const unnest = {
        ...input,
        commandId: CommandId.make("unnest-refresh"),
        parentThreadId: null,
      };
      yield* service.update(unnest);
      assert.equal((yield* management.getThreadShell(threadId))!.forkMetadataRevision, 2);
      yield* service.update(input); // replaying an older receipt must not restore the parent or emit again
      assert.equal(
        (yield* service.list()).find((row) => row.threadId === threadId)?.parentThreadId,
        null,
      );
      assert.equal(
        (yield* Stream.runCollect(events.readByCommandId({ commandId: refreshId }))).length,
        1,
      );
      assert.equal(
        (yield* Stream.runCollect(
          events.readByCommandId({ commandId: CommandId.make("unnest-refresh:shell-refresh") }),
        )).length,
        1,
      );
      const cliRequests: ForkThreadMetadataUpdate[] = [];
      let receiveRpc!: (value: ForkThreadMetadataUpdate) => void;
      let finishRpc!: (value: ForkThreadMetadata) => void;
      let cliResponse!: Promise<ForkThreadMetadata>;
      const cliArguments = [
        {
          name: "cli-refresh",
          httpBaseUrl: "http://127.0.0.1:1",
          wsBaseUrl: "ws://127.0.0.1:1",
          environmentId: "cli-refresh",
          label: "CLI test",
          serverVersion: "test",
          bearerToken: "test",
          expiresAt: "2099-01-01T00:00:00.000Z",
          pairedAt: "2026-10-06T00:00:00.000Z",
        },
        {
          descriptorFactory: async () => ({
            environmentId: "cli-refresh",
            label: "CLI test",
            serverVersion: "test",
            capabilities: { threadNesting: true },
          }),
          rpcFactory: () => ({
            request: async <T>(method: string, payload: unknown): Promise<T> => {
              assert.equal(method, "threadMetadataUpdate");
              const value = decodeCliMetadata(payload);
              cliRequests.push(value);
              return (await new Promise<ForkThreadMetadata>((resolve) => {
                finishRpc = resolve;
                receiveRpc(value);
              })) as T;
            },
            subscribeShellSnapshot: async <T>(): Promise<T> => {
              throw new CliTransportError({ cause: "Unused snapshot" });
            },
            subscribeThreadSnapshot: async <T>(): Promise<T> => {
              throw new CliTransportError({ cause: "Unused snapshot" });
            },
            dispose: async () => {},
          }),
        },
      ] as const;
      // Load CLI under its own workspace boundary, rather than server compiler policy.
      const cliModulePath = new URL("../../../t3-thread/src/client.ts", import.meta.url).href;
      const cliModule = (yield* Effect.promise(() => import(cliModulePath))) as {
        RemoteEnvironmentClient: new (
          environment: (typeof cliArguments)[0],
          options: (typeof cliArguments)[1],
        ) => {
          setThreadParent: (
            threadId: string,
            parentThreadId: string | null,
          ) => Promise<ForkThreadMetadata>;
        };
      };
      const cli = new cliModule.RemoteEnvironmentClient(...cliArguments);
      const cliRequest = yield* Effect.callback<ForkThreadMetadataUpdate, CliTransportError>(
        (resume) => {
          receiveRpc = (value) => resume(Effect.succeed(value));
          cliResponse = cli.setThreadParent(threadId, parentId);
          void cliResponse.catch((cause) => resume(Effect.fail(new CliTransportError({ cause }))));
        },
      );
      // The test fiber services the real CLI request, then releases its RPC response.
      finishRpc(yield* service.update(cliRequest));
      const cliResult = yield* Effect.tryPromise(() => cliResponse);
      assert.equal(cliResult.parentThreadId, parentId);
      assert.equal(cliRequests.length, 1);
      const cliRefresh = yield* Stream.runCollect(
        events.readByCommandId({
          commandId: CommandId.make(`${cliRequests[0]!.commandId}:shell-refresh`),
        }),
      );
      assert.equal(cliRefresh.length, 1);
      assert.equal(cliRefresh[0]?.event.type, "thread.metadata-updated");
      assert.equal(
        (yield* service.list()).find((row) => row.threadId === threadId)?.parentThreadId,
        parentId,
      );
      const invalid = {
        ...input,
        commandId: CommandId.make("invalid-refresh"),
        parentThreadId: threadId,
      };
      assert.equal((yield* Effect.exit(service.update(invalid)))._tag, "Failure");
      assert.equal(
        (yield* Stream.runCollect(
          events.readByCommandId({ commandId: CommandId.make("invalid-refresh:shell-refresh") }),
        )).length,
        0,
      );
    }).pipe(Effect.provide(layer)),
);
