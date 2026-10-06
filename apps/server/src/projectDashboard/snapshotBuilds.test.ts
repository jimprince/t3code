import { expect } from "vite-plus/test";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layouts from "../projectLayout/ProjectLayoutService.ts";
import * as Dashboard from "./ProjectDashboardService.ts";
import * as Store from "./ProjectDashboardStore.ts";
import { fixture, root, child, projectId } from "./snapshotBuilds.testkit.ts";
it.effect("builds the shell once per dashboard request and retains root/tracker/widgets", () =>
  fixture((builds) =>
    Effect.gen(function* () {
      const layouts = yield* Layouts.ProjectLayoutService;
      const dashboard = yield* Dashboard.make(yield* Store.make, layouts);
      const result = yield* dashboard.get({ threadId: child });
      expect(result).toMatchObject({
        rootThreadId: root,
        rootProjectId: projectId,
        tracker: "brad/project",
        widgets: null,
      });
      expect(builds()).toBe(1);
      yield* dashboard.get({ threadId: child });
      expect(builds()).toBe(2);
    }),
  ),
);
