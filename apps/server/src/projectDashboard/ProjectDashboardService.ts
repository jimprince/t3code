import {
  ProjectDashboardError,
  ProjectHealth,
  type ProjectDashboardSetHealthInput,
  type ProjectDashboard,
  type ProjectDashboardGetInput,
  type ProjectDashboardSetTrackerInput,
  type ProjectDashboardSetWidgetsInput,
  type ThreadId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { findRootThreadId } from "../projectIssues/projectIssues.logic.ts";
import { legacyWidgetOrder, widgetOrderOps } from "@t3tools/contracts";
import type * as ProjectLayoutService from "../projectLayout/ProjectLayoutService.ts";
import { normalizeWidgets, resolveTrackerSetting } from "./projectDashboard.logic.ts";
import type { ProjectDashboardStore } from "./ProjectDashboardStore.ts";

const fail = (message: string) => new ProjectDashboardError({ message });
const decodeHealth = Schema.decodeUnknownOption(ProjectHealth);

/**
 * Reads and writes a project page's Gitea tracker repository, and its first tab's
 * widget order for older clients and the CLI's `dashboard show|set`: the order
 * lives in the project layout now.
 */
export const make = (
  store: ProjectDashboardStore,
  layouts: ProjectLayoutService.ProjectLayoutService["Service"],
) =>
  Effect.gen(function* () {
    const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
    const settings = yield* ServerSettingsService;

    /** Any thread's orchestrator (root) thread and that thread's T3 project. */
    const resolveRoot = (threadId: ThreadId) =>
      Effect.gen(function* () {
        const snapshot = yield* snapshots
          .getShellSnapshot()
          .pipe(Effect.mapError(() => fail("Could not read threads.")));
        const rootThreadId = findRootThreadId(snapshot.threads, threadId);
        const root = snapshot.threads.find((thread) => thread.id === rootThreadId);
        if (!root) return yield* fail(`Thread '${threadId}' was not found.`);
        return { rootThreadId: root.id, rootProjectId: root.projectId };
      });

    const get = (input: ProjectDashboardGetInput) =>
      Effect.gen(function* () {
        const { rootThreadId, rootProjectId } = yield* resolveRoot(input.threadId);
        const file = yield* store.read;
        const layout = yield* layouts
          .get(rootThreadId)
          .pipe(Effect.mapError((error) => fail(error.message)));
        return {
          rootThreadId,
          rootProjectId,
          widgets:
            layout.revision > 0
              ? legacyWidgetOrder(layout.tabs)
              : (file.dashboards[rootThreadId]?.widgets ?? null),
          tracker: file.trackers[rootProjectId] ?? null,
          health: Option.getOrNull(decodeHealth(file.health[rootThreadId])),
        } satisfies ProjectDashboard;
      });

    const setWidgets = (input: ProjectDashboardSetWidgetsInput) =>
      Effect.gen(function* () {
        const { rootThreadId } = yield* resolveRoot(input.threadId);
        const actor = { kind: "user" as const, threadId: null, reason: "dashboard set" };
        const layout = yield* layouts
          .get(rootThreadId)
          .pipe(Effect.mapError((error) => fail(error.message)));
        // `--reset` restores the default layout; an order replaces the first tab's widgets.
        if (input.widgets === null) {
          yield* layouts
            .revert({ threadId: rootThreadId, toRevision: 0 }, actor)
            .pipe(Effect.mapError((error) => fail(error.message)));
        } else {
          const order = widgetOrderOps(layout.tabs, normalizeWidgets(input.widgets));
          if ("error" in order) return yield* fail(order.error);
          yield* layouts
            .apply({ threadId: rootThreadId, baseRevision: layout.revision, ops: order.ops }, actor)
            .pipe(Effect.mapError((error) => fail(error.message)));
        }
        return yield* get(input);
      });

    const setTracker = (input: ProjectDashboardSetTrackerInput) =>
      Effect.gen(function* () {
        const { rootProjectId } = yield* resolveRoot(input.threadId);
        if (input.tracker !== null) {
          const config = yield* settings.getSettings.pipe(
            Effect.mapError(() => fail("Could not read configured Gitea connections.")),
          );
          if (!resolveTrackerSetting(input.tracker, config.giteaInstances)) {
            return yield* fail(
              "Expected owner/repo or a repository URL on a configured Gitea instance.",
            );
          }
        }
        yield* store
          .modify((file) => {
            const trackers = { ...file.trackers };
            if (input.tracker === null) delete trackers[rootProjectId];
            else trackers[rootProjectId] = input.tracker.trim();
            return { ...file, trackers };
          })
          .pipe(Effect.mapError(() => fail("Could not save the tracker repository.")));
        return yield* get(input);
      });

    /** The orchestrator writes the project's health line; the newest one wins. */
    const setHealth = (input: ProjectDashboardSetHealthInput) =>
      Effect.gen(function* () {
        const { rootThreadId } = yield* resolveRoot(input.threadId);
        const updatedAt = DateTime.formatIso(DateTime.makeUnsafe(yield* Clock.currentTimeMillis));
        const health: ProjectHealth = {
          status: input.status,
          sentence: input.sentence,
          updatedAt,
          threadId: input.threadId,
        };
        yield* store
          .modify((file) => ({ ...file, health: { ...file.health, [rootThreadId]: health } }))
          .pipe(Effect.mapError(() => fail("Could not save the health line.")));
        return yield* get(input);
      });

    return { get, setWidgets, setTracker, setHealth };
  });
