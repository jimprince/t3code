import {
  applyLayoutOps,
  defaultProjectLayoutTabs,
  PROJECT_LAYOUT_LIMITS,
  ProjectLayout,
  ProjectLayoutError,
  type ProjectLayoutActor,
  type ProjectLayoutApplyInput,
  type ProjectLayoutHistory,
  type ProjectLayoutHistoryInput,
  type ProjectLayoutOp,
  type ProjectLayoutRevertInput,
  type ProjectLayoutTab,
  type ThreadId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ProjectDashboardStore from "../projectDashboard/ProjectDashboardStore.ts";
import { findRootThreadId } from "../projectIssues/projectIssues.logic.ts";

const fail = (message: string, layout?: ProjectLayout) =>
  new ProjectLayoutError({ message, ...(layout ? { layout } : {}) });
const decodeLayout = Schema.decodeUnknownOption(ProjectLayout);

/**
 * One project page layout per orchestrator (root) thread: tabs of widgets that
 * Brad (drag and drop), the orchestrator (MCP tools) and the CLI all change
 * through the same ops. Kept in the dashboard settings file with its last 50
 * revisions, and published to every subscribed client after each change.
 */
export class ProjectLayoutService extends Context.Service<
  ProjectLayoutService,
  {
    /** The project's orchestrator thread for any thread in its tree. */
    readonly rootOf: (threadId: ThreadId) => Effect.Effect<ThreadId, ProjectLayoutError>;
    readonly get: (threadId: ThreadId) => Effect.Effect<ProjectLayout, ProjectLayoutError>;
    readonly apply: (
      input: ProjectLayoutApplyInput,
      actor: ProjectLayoutActor,
    ) => Effect.Effect<ProjectLayout, ProjectLayoutError>;
    readonly revert: (
      input: ProjectLayoutRevertInput,
      actor: ProjectLayoutActor,
    ) => Effect.Effect<ProjectLayout, ProjectLayoutError>;
    readonly history: (
      input: ProjectLayoutHistoryInput,
    ) => Effect.Effect<ProjectLayoutHistory, ProjectLayoutError>;
    /** The layout now, then every new revision. */
    readonly stream: (threadId: ThreadId) => Stream.Stream<ProjectLayout, ProjectLayoutError>;
  }
>()("t3/projectLayout/ProjectLayoutService") {}

const make = Effect.gen(function* () {
  const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const store = yield* ProjectDashboardStore.make;
  const changes = yield* PubSub.unbounded<ProjectLayout>();

  const rootOf = (threadId: ThreadId) =>
    snapshots.getShellSnapshot().pipe(
      Effect.mapError(() => fail("Could not read threads.")),
      Effect.flatMap((snapshot) => {
        const rootThreadId = findRootThreadId(snapshot.threads, threadId);
        return snapshot.threads.some((thread) => thread.id === rootThreadId)
          ? Effect.succeed(rootThreadId)
          : Effect.fail(fail(`Thread '${threadId}' was not found.`));
      }),
    );

  /** Saved revisions, oldest first; empty until the project changes its layout. */
  const savedHistory = (rootThreadId: ThreadId) =>
    store.read.pipe(
      Effect.map((file) =>
        (file.layouts[rootThreadId]?.history ?? []).flatMap((entry) =>
          Option.toArray(decodeLayout(entry)),
        ),
      ),
    );

  /** The current layout: the newest saved revision, or the default built from the old widget order. */
  const current = (rootThreadId: ThreadId) =>
    Effect.gen(function* () {
      const history = yield* savedHistory(rootThreadId);
      const latest = history.at(-1);
      if (latest) return latest;
      const file = yield* store.read;
      return {
        rootThreadId,
        revision: 0,
        updatedAt: null,
        updatedBy: null,
        tabs: defaultProjectLayoutTabs(file.dashboards[rootThreadId]?.widgets ?? null),
      } satisfies ProjectLayout;
    });

  const get = (threadId: ThreadId) => rootOf(threadId).pipe(Effect.flatMap(current));

  /** Saves tabs as the next revision under the file lock, then tells every subscriber. */
  const save = (
    rootThreadId: ThreadId,
    change: (layout: ProjectLayout) => { tabs: ProjectLayoutTab[] } | { error: string },
    actor: ProjectLayoutActor,
  ) =>
    Effect.gen(function* () {
      const now = DateTime.formatIso(DateTime.makeUnsafe(yield* Clock.currentTimeMillis));
      let saved: ProjectLayout | null = null;
      let failure: ProjectLayoutError | null = null;
      // The change runs inside the file lock against the newest revision, so two
      // writers never overwrite each other.
      const base = yield* current(rootThreadId);
      yield* store
        .modify((file) => {
          const stored = (file.layouts[rootThreadId]?.history ?? []).flatMap((entry) =>
            Option.toArray(decodeLayout(entry)),
          );
          const latest = stored.at(-1) ?? base;
          const result = change(latest);
          if ("error" in result) {
            failure = fail(result.error, latest);
            return file;
          }
          const next: ProjectLayout = {
            rootThreadId,
            revision: latest.revision + 1,
            updatedAt: now,
            updatedBy: actor,
            tabs: result.tabs,
          };
          saved = next;
          return {
            ...file,
            layouts: {
              ...file.layouts,
              [rootThreadId]: {
                history: [...stored, next].slice(-PROJECT_LAYOUT_LIMITS.history),
              },
            },
          };
        })
        .pipe(Effect.mapError(() => fail("Could not save the layout.")));
      if (failure) return yield* Effect.fail(failure as ProjectLayoutError);
      const layout = saved as unknown as ProjectLayout;
      yield* PubSub.publish(changes, layout);
      return layout;
    });

  const apply = (input: ProjectLayoutApplyInput, actor: ProjectLayoutActor) =>
    Effect.gen(function* () {
      const rootThreadId = yield* rootOf(input.threadId);
      const replaces = input.ops.some((op: ProjectLayoutOp) => op.op === "replaceLayout");
      return yield* save(
        rootThreadId,
        (latest) =>
          replaces && latest.revision !== input.baseRevision
            ? {
                error: `The layout changed (revision ${latest.revision}, you edited ${input.baseRevision}); reload it and replace again.`,
              }
            : applyLayoutOps(latest.tabs, input.ops),
        { ...actor, reason: input.reason?.trim() || actor.reason },
      );
    });

  const revert = (input: ProjectLayoutRevertInput, actor: ProjectLayoutActor) =>
    Effect.gen(function* () {
      const rootThreadId = yield* rootOf(input.threadId);
      const history = yield* savedHistory(rootThreadId);
      const file = yield* store.read;
      const target =
        input.toRevision === 0
          ? defaultProjectLayoutTabs(file.dashboards[rootThreadId]?.widgets ?? null)
          : history.find((entry) => entry.revision === input.toRevision)?.tabs;
      if (!target) {
        return yield* fail(`Revision ${input.toRevision} is no longer in the history.`);
      }
      return yield* save(rootThreadId, () => ({ tabs: [...target] }), {
        ...actor,
        reason: actor.reason ?? `Restored revision ${input.toRevision}`,
      });
    });

  const history = (input: ProjectLayoutHistoryInput) =>
    Effect.gen(function* () {
      const rootThreadId = yield* rootOf(input.threadId);
      const entries = (yield* savedHistory(rootThreadId))
        .toReversed()
        .slice(0, input.limit ?? 20)
        .map((layout) => ({
          revision: layout.revision,
          updatedAt: layout.updatedAt,
          updatedBy: layout.updatedBy,
          tabs: layout.tabs.map((tab) => tab.title),
        }));
      return { entries } satisfies ProjectLayoutHistory;
    });

  // One-slot sliding mailbox per subscriber: layouts are whole documents, so a
  // slow client only ever needs the newest.
  const stream = (threadId: ThreadId) =>
    Stream.callback<ProjectLayout, ProjectLayoutError>(
      (mailbox) =>
        Effect.gen(function* () {
          const rootThreadId = yield* rootOf(threadId);
          const subscription = yield* PubSub.subscribe(changes);
          Queue.offerUnsafe(mailbox, yield* current(rootThreadId));
          yield* Stream.fromSubscription(subscription).pipe(
            Stream.filter((layout) => layout.rootThreadId === rootThreadId),
            Stream.runForEach((layout) => Effect.sync(() => Queue.offerUnsafe(mailbox, layout))),
            Effect.forkScoped,
          );
        }),
      { bufferSize: 1, strategy: "sliding" },
    );

  return ProjectLayoutService.of({ rootOf, get, apply, revert, history, stream });
});

export const layer = Layer.effect(ProjectLayoutService, make);
