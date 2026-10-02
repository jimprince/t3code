import {
  DEFAULT_SERVER_SETTINGS,
  CommandId,
  MessageId,
  ThreadId,
  ProjectId,
  ProviderInstanceId,
  type OrchestrationThreadShell,
  type OrchestrationShellSnapshot,
  type OrchestrationCommand,
  type OrchestrationEvent,
  type ServerSettings,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";
import { ServerActivation } from "../serverActivation.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { OrchestrationEngineService } from "./Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "./Services/ProjectionSnapshotQuery.ts";
import * as Archive from "./SettledSubthreadArchiveReactor.ts";
import { isSettledSubthreadArchiveCandidate } from "./SettledSubthreadArchivePolicy.ts";
import { decideOrchestrationCommand } from "./decider.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";

const NOW = "2026-10-01T00:00:00.000Z";
const OLD = "2026-09-23T00:00:00.000Z";
const projectId = ProjectId.make("project");
function thread(
  id: string,
  overrides: Partial<OrchestrationThreadShell> = {},
): OrchestrationThreadShell {
  return {
    id: ThreadId.make(id),
    projectId,
    title: id,
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6.1-sol" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    pullRequests: [],
    createdAt: OLD,
    updatedAt: OLD,
    archivedAt: null,
    settledOverride: "settled",
    settledAt: OLD,
    parentThreadId: ThreadId.make("root"),
    latestTurn: null,
    session: null,
    latestUserMessageAt: OLD,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    ...overrides,
  };
}
const snapshot = (threads: readonly OrchestrationThreadShell[]): OrchestrationShellSnapshot => ({
  snapshotSequence: 1,
  projects: [],
  threads,
  updatedAt: NOW,
});

it.effect(
  "archives eligible workers at startup and the next deadline, then stays asleep without due work",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(NOW));
        const rows = yield* Ref.make(
          snapshot([
            thread("old"),
            thread("retained", { projectId: ProjectId.make("retained-project") }),
            thread("future", { settledAt: NOW }),
            thread("pinned", { pinnedAt: NOW }),
            thread("permanent", { autoSettleDisabledAt: NOW }),
            thread("top-level", { parentThreadId: null }),
            thread("parent"),
            thread("grandchild", {
              parentThreadId: ThreadId.make("archived-middle"),
              settledOverride: null,
              settledAt: null,
            }),
          ]),
        );
        const archived = snapshot([
          thread("archived-middle", { parentThreadId: ThreadId.make("parent"), archivedAt: NOW }),
        ]);
        const reads = yield* Queue.unbounded<void>();
        const receipts =
          yield* Queue.unbounded<Extract<OrchestrationCommand, { type: "thread.archive" }>>();
        const events = yield* PubSub.unbounded<OrchestrationEvent>();
        const changes = yield* PubSub.unbounded<ServerSettings>();
        const activation = yield* Deferred.make<void>();
        const readCount = yield* Ref.make(0);
        const deps = Layer.mergeAll(
          Layer.mock(ProjectionSnapshotQuery)({
            getShellSnapshot: () =>
              Ref.get(rows).pipe(
                Effect.tap(() => Ref.update(readCount, (n) => n + 1)),
                Effect.tap(() => Queue.offer(reads, undefined)),
              ),
            getArchivedShellSnapshot: () => Effect.succeed(archived),
          }),
          Layer.mock(OrchestrationEngineService)({
            subscribeDomainEvents: PubSub.subscribe(events).pipe(
              Effect.map(Stream.fromSubscription),
            ),
            dispatch: (command) => {
              if (command.type !== "thread.archive")
                return Effect.die(new Error("Expected archive command"));
              return Ref.update(rows, (state) => ({
                ...state,
                threads: state.threads.filter((row) => row.id !== command.threadId),
              })).pipe(Effect.andThen(Queue.offer(receipts, command)), Effect.as({ sequence: 2 }));
            },
          }),
          Layer.mock(ServerSettingsService)({
            getSettings: Effect.succeed({
              ...DEFAULT_SERVER_SETTINGS,
              projectSettingsOverrides: {
                [projectId]: { settledSubthreadArchiveAfterDays: 7 },
                [ProjectId.make("retained-project")]: { settledSubthreadArchiveAfterDays: null },
              },
            }),
            subscribeChanges: PubSub.subscribe(changes).pipe(Effect.map(Stream.fromSubscription)),
          }),
          Layer.succeed(ServerActivation, Deferred.await(activation)),
          Layer.succeed(
            Crypto.Crypto,
            Crypto.make({
              randomBytes: (size) => new Uint8Array(size).fill(1),
              digest: (_algorithm, data) => Effect.succeed(data),
            }),
          ),
        );
        yield* Effect.gen(function* () {
          const service = yield* Archive.SettledSubthreadArchiveReactor;
          yield* service.start();
          yield* Deferred.succeed(activation, undefined);
          const first = yield* Queue.take(receipts);
          assert.strictEqual(first.threadId, ThreadId.make("old"));
          assert.strictEqual(first.type, "thread.archive");
          yield* service.drain;
          yield* TestClock.adjust("7 days");
          const second = yield* Queue.take(receipts);
          assert.strictEqual(second.threadId, ThreadId.make("future"));
          yield* service.drain;
          const count = yield* Ref.get(readCount);
          yield* TestClock.adjust("30 days");
          yield* service.drain;
          assert.strictEqual(yield* Ref.get(readCount), count);
          assert.strictEqual(
            (yield* Ref.get(rows)).threads.some((row) => row.id === "parent"),
            true,
          );
        }).pipe(Effect.provide(Archive.layer.pipe(Layer.provide(deps))));
      }),
    ),
);

it.layer(NodeServices.layer)("automatic archive decider", (it) => {
  it.effect("rechecks protected descendants and preserves the existing unarchive path", () =>
    Effect.gen(function* () {
      const parent = thread("parent");
      const child = thread("child", { parentThreadId: parent.id, settledOverride: null });
      const model = (threads: readonly OrchestrationThreadShell[]) => ({
        snapshotSequence: 1,
        projects: [],
        updatedAt: NOW,
        threads: threads.map((row) => ({
          ...row,
          deletedAt: null,
          messages: [],
          activities: [],
          proposedPlans: [],
          checkpoints: [],
        })),
      });
      const command = {
        type: "thread.archive" as const,
        commandId: CommandId.make("archive"),
        threadId: parent.id,
        autoArchiveSettledBefore: NOW,
      };
      const rejected = yield* decideOrchestrationCommand({
        command,
        readModel: model([parent, child]),
      }).pipe(Effect.result);
      assert.strictEqual(rejected._tag, "Failure");
      for (const guarded of [
        thread("parent", { pinnedAt: NOW }),
        thread("parent", { autoSettleDisabledAt: NOW }),
      ]) {
        assert.strictEqual(isSettledSubthreadArchiveCandidate(guarded, [guarded], NOW), false);
      }
      const pinnedActive = thread("pinned-active", {
        pinnedAt: NOW,
        settledOverride: null,
        settledAt: null,
      });
      for (const type of ["thread.auto-settle", "thread.settle"] as const) {
        const settlement = yield* decideOrchestrationCommand({
          command:
            type === "thread.auto-settle"
              ? {
                  type,
                  commandId: CommandId.make(type),
                  threadId: pinnedActive.id,
                  settledAt: NOW,
                  snapshotSequence: 1,
                }
              : { type, commandId: CommandId.make(type), threadId: pinnedActive.id },
          readModel: model([pinnedActive]),
        });
        assert.strictEqual(
          ("type" in settlement ? [settlement] : settlement).some(
            (event) => event.type === "thread.unpinned",
          ),
          type === "thread.settle",
        );
      }
      const resumed = yield* decideOrchestrationCommand({
        command: {
          type: "thread.turn.start",
          commandId: CommandId.make("parent-follow-up"),
          threadId: parent.id,
          message: {
            messageId: MessageId.make("follow-up"),
            role: "user",
            text: "Continue",
            attachments: [],
          },
          runtimeMode: "full-access",
          interactionMode: "default",
          createdAt: NOW,
        },
        readModel: model([parent]),
      });
      assert.ok(
        ("type" in resumed ? [resumed] : resumed).some(
          (event) => event.type === "thread.unsettled",
        ),
      );
      const accepted = yield* decideOrchestrationCommand({ command, readModel: model([parent]) });
      assert.strictEqual("type" in accepted ? accepted.type : accepted[0]?.type, "thread.archived");
      assert.strictEqual(
        isSettledSubthreadArchiveCandidate({ ...parent, updatedAt: NOW }, [parent], OLD),
        false,
      );
      const restored = yield* decideOrchestrationCommand({
        command: {
          type: "thread.unarchive",
          commandId: CommandId.make("restore"),
          threadId: parent.id,
        },
        readModel: model([{ ...parent, archivedAt: NOW }]),
      });
      assert.strictEqual(
        "type" in restored ? restored.type : restored[0]?.type,
        "thread.unarchived",
      );
    }),
  );
});
