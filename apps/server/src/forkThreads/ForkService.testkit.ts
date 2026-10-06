import { type Project } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as Projections from "../orchestration-v2/ProjectionStore.ts";
import * as Events from "../orchestration-v2/EventStore.ts";
import * as Sink from "../orchestration-v2/EventSink.ts";
import * as Receipts from "../orchestration-v2/CommandReceiptStore.ts";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import * as Projects from "../project/ProjectService.ts";
import * as Git from "../git/GitWorkflowService.ts";
import * as Portable from "./PortableHistory.ts";
const unused = () => Effect.die("Unexpected test boundary call");
const stores = Layer.mergeAll(Projections.layer, Events.layer, Receipts.layer).pipe(
  Layer.provideMerge(SqlitePersistenceMemory),
);
export const persisted = Layer.merge(stores, Sink.layer.pipe(Layer.provide(stores)));
export const portable = Portable.layer.pipe(Layer.provideMerge(persisted));
export const threads = Layer.effect(
  Threads.ThreadManagementService,
  Effect.gen(function* () {
    const projections = yield* Projections.ProjectionStoreV2;
    return Threads.ThreadManagementService.of({
      ensureLegacyTranscript: () => Effect.void,
      dispatch: unused,
      getTimelinePage: unused,
      getMessageCount: unused,
      getTurnItem: unused,
      readImportedAutomationOutcome: unused,
      getThreadRecords: unused,
      getThreadProjection: (id) => projections.getThreadProjection(id).pipe(Effect.orDie),
      getCheckpointContext: unused,
      getThreadSnapshot: unused,
      getThreadSnapshotWindow: unused,
      getProjectThreadRecords: unused,
      getProjectThread: unused,
      getShellSnapshot: unused,
      getThreadShells: (ids) => projections.getThreadShells(ids).pipe(Effect.orDie),
      getThreadShell: (id) => projections.getThreadShell(id).pipe(Effect.orDie),
      listProjectThreads: unused,
      sendToThread: unused,
      waitForThread: unused,
      interruptThread: unused,
      getThreadEventSequence: unused,
      recoverDelegatedTask: unused,
      delegatedTaskResultPending: unused,
      streamStoredEvents: Stream.empty,
      streamStoredEventsFrom: () => Stream.empty,
      streamDomainEvents: Stream.empty,
    });
  }),
).pipe(Layer.provide(persisted));
export const projects = Layer.succeed(
  Projects.ProjectService,
  Projects.ProjectService.of({
    create: unused,
    bootstrap: unused,
    update: unused,
    delete: unused,
    getById: (id) =>
      Effect.succeed(
        Option.some({
          id,
          title: "Target",
          workspaceRoot: "/target",
          defaultModelSelection: null,
          scripts: [],
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-01T00:00:00Z",
          deletedAt: null,
        } satisfies Project),
      ),
    getByWorkspaceRoot: unused,
    snapshot: Effect.die("unused"),
    getShell: unused,
    listShells: unused,
  }),
);

export const gitBoundary = (overrides: Partial<Git.GitWorkflowService["Service"]>) =>
  Git.GitWorkflowService.of({
    isRepository: unused,
    hasCommit: unused,
    status: unused,
    localStatus: unused,
    remoteStatus: unused,
    invalidateLocalStatus: unused,
    invalidateRemoteStatus: unused,
    invalidateStatus: unused,
    pullCurrentBranch: unused,
    runStackedAction: unused,
    resolvePullRequest: unused,
    preparePullRequestThread: unused,
    listLocalBranchNames: unused,
    resolveRemoteWorktreeBase: unused,
    fetchRemote: unused,
    listRemoteNames: unused,
    remoteExists: unused,
    remoteBranchExists: unused,
    resolveRemoteTrackingCommit: unused,
    removeWorktree: unused,
    pruneWorktrees: unused,
    deleteLocalBranch: unused,
    createRef: unused,
    switchRef: unused,
    renameBranch: unused,
    listRefs: unused,
    createWorktree: unused,
    ...overrides,
  });
