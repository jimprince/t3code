import { expect } from "vite-plus/test";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Issues from "../projectIssues/ProjectIssuesService.ts";
import * as Ledger from "../projectIssues/RequestLedger.ts";
import * as Roadmap from "./ProjectRoadmapService.ts";
import { fixture, child } from "../projectDashboard/snapshotBuilds.testkit.ts";
it.effect("builds the shell once per roadmap request and retains versions and issues", () =>
  fixture((builds) =>
    Effect.gen(function* () {
      const projectIssues = yield* Issues.make;
      const ledger = yield* Ledger.make({ projectIssues, threadIssues: {} as never });
      const roadmap = yield* Roadmap.make({ projectIssues, ledger });
      const result = yield* roadmap.get({ threadId: child });
      expect(result.tracker).toEqual({ host: "git.test", repository: "brad/project" });
      expect(result.versions).toMatchObject([{ id: 1, title: "Oct 15" }]);
      expect(result.items).toMatchObject([{ title: "Load fixes" }]);
      expect(builds()).toBe(1);
      yield* roadmap.get({ threadId: child });
      expect(builds()).toBe(2);
    }),
  ),
);
