import { assert, it } from "@effect/vitest";
import { CommandId, EventId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Projections from "../orchestration-v2/ProjectionStore.ts";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import { OrchestratorDispatchError } from "../orchestration-v2/Orchestrator.ts";
import * as Git from "../git/GitWorkflowService.ts";
import { v2Projection } from "../../../../packages/client-runtime/src/state/orchestrationV2TestFixtures.ts";
import * as Portable from "./PortableHistory.ts";
import * as ForkWorkspace from "./ForkWorkspaceService.ts";
import { portable, persisted, threads, projects, gitBoundary } from "./ForkService.testkit.ts";

const git = Layer.effect(
  Git.GitWorkflowService,
  Effect.gen(function* () {
    const branches = yield* Ref.make<Array<{ name: string; path: string }>>([]);
    return gitBoundary({
      listRefs: () =>
        Ref.get(branches).pipe(
          Effect.map((rows) => ({
            refs: rows.map((row) => ({
              name: row.name,
              worktreePath: row.path,
              current: false,
              isDefault: false,
            })),
            isRepo: true,
            hasPrimaryRemote: false,
            nextCursor: null,
            totalCount: rows.length,
          })),
        ),
      createWorktree: (input) =>
        Effect.gen(function* () {
          const branch = input.newRefName!;
          const path = `/owned/${branch}`;
          yield* Ref.update(branches, (current) => [...current, { name: branch, path }]);
          return { worktree: { path, refName: branch } };
        }),
    });
  }),
);
const nativeBoundary = Layer.effect(
  Threads.ThreadManagementService,
  Effect.gen(function* () {
    const original = yield* Threads.ThreadManagementService;
    const projections = yield* Projections.ProjectionStoreV2;
    const failed = yield* Ref.make(false);
    return Threads.ThreadManagementService.of({
      ...original,
      dispatch: (command) =>
        Effect.gen(function* () {
          if (command.type !== "thread.metadata.update")
            return yield* new OrchestratorDispatchError({
              commandId: command.commandId,
              commandType: command.type,
              cause: "unexpected test command",
            });
          if (!(yield* Ref.get(failed))) {
            yield* Ref.set(failed, true);
            return yield* new OrchestratorDispatchError({
              commandId: command.commandId,
              commandType: command.type,
              cause: "injected workspace publication failure",
            });
          }
          const projection = yield* projections
            .getThreadProjection(command.threadId)
            .pipe(Effect.orDie);
          yield* projections
            .apply({
              id: EventId.make(`${command.commandId}:event`),
              type: "thread.metadata-updated",
              threadId: command.threadId,
              occurredAt: projection.thread.updatedAt,
              payload: {
                ...projection.thread,
                branch: command.branch ?? null,
                worktreePath: command.worktreePath ?? null,
              },
            })
            .pipe(Effect.orDie);
          return { sequence: 0, storedEvents: [] };
        }),
    });
  }),
).pipe(Layer.provide(Layer.merge(threads, persisted)));
const dependencies = Layer.mergeAll(portable, nativeBoundary, projects, git);
const live = ForkWorkspace.layer.pipe(Layer.provideMerge(dependencies));

it.effect(
  "forks imported history in the current or an owned new worktree, preserves source and rejects changed retry parameters",
  () =>
    Effect.gen(function* () {
      const history = yield* Portable.PortableHistory;
      const fork = yield* ForkWorkspace.ForkWorkspaceService;
      const projections = yield* Projections.ProjectionStoreV2;
      const sourceId = ThreadId.make("imported-source");
      yield* history.import({
        commandId: CommandId.make("seed-source"),
        thread: { ...v2Projection.thread, id: sourceId, worktreePath: "/existing" },
        messages: [],
      });
      const source = yield* projections.getThreadProjection(sourceId);
      for (const workspaceMode of ["current", "new-worktree"] as const) {
        const input = {
          commandId: CommandId.make(`fork:${workspaceMode}`),
          sourceThreadId: sourceId,
          targetThreadId: ThreadId.make(`fork-${workspaceMode}`),
          sourcePoint: { type: "latest_stable" as const },
          workspaceMode,
        };
        if (workspaceMode === "new-worktree") {
          const interrupted = yield* Effect.result(fork.fork(input));
          assert.equal(interrupted._tag, "Failure");
          assert.equal(
            (yield* projections.getThreadProjection(input.targetThreadId)).thread.lineage
              .parentThreadId,
            sourceId,
          );
        }
        const first = yield* fork.fork(input);
        assert.equal(first.threadId, input.targetThreadId);
        assert.equal(
          first.worktreePath,
          workspaceMode === "current" ? "/existing" : `/owned/t3-fork-${input.targetThreadId}`,
        );
        assert.deepStrictEqual(yield* fork.fork(input), first);
        const child = yield* projections.getThreadProjection(first.threadId);
        assert.equal(child.thread.lineage.parentThreadId, sourceId);
        assert.equal(child.thread.worktreePath, first.worktreePath);
        assert.equal(child.thread.forkedFrom, null);
        assert.equal(child.runs.length, 0);
        assert.equal(child.checkpoints.length, 0);
        const changed = yield* Effect.result(fork.fork({ ...input, title: "Changed retry" }));
        assert.equal(changed._tag, "Failure");
      }
      assert.deepStrictEqual(yield* projections.getThreadProjection(sourceId), source);
    }).pipe(Effect.provide(live)),
);
