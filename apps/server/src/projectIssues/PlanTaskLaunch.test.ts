import { describe, expect } from "vite-plus/test";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { layerMemory as SqlitePersistenceMemory } from "../persistence/Sqlite.ts";
import { ProjectId, RunId, ThreadId } from "@t3tools/contracts";
import {
  ThreadLaunchService,
  ThreadLaunchError,
  type ThreadLaunchInput,
} from "../orchestration-v2/ThreadLaunchService.ts";
import { ThreadManagementService } from "../orchestration-v2/ThreadManagementService.ts";
import { make } from "./PlanTaskLaunch.ts";
import { listMetadata } from "../forkThreads/MetadataStore.ts";
import * as SqlClient from "effect/sql/SqlClient";

describe("plan task launch", () => {
  it.effect(
    "records supervision before an issue-gated first message and recovers the same worker on retry",
    () => {
      const parentId = ThreadId.make("owner");
      const projectId = ProjectId.make("project");
      const shells = new Set<ThreadId>([parentId]);
      const calls: ThreadLaunchInput[] = [];
      const started = new Set<ThreadId>();
      let failStart = true;
      return Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const start = yield* make;
        const input = {
          parentThreadId: parentId,
          identity: "stable-task",
          issue: "https://git.test/brad/tasks/issues/2",
          task: {
            key: "parser",
            title: "Parse input",
            owner: "Specialist",
            detail: "Reject invalid input.",
          },
        };
        expect((yield* start(input).pipe(Effect.flip)).message).toContain("Could not launch");
        failStart = false;
        const first = yield* start(input);
        const second = yield* start(input);
        expect(second).toBe(first);
        expect(new Set(calls.map((call) => call.threadId)).size).toBe(1);
        expect(
          new Set(calls.filter((call) => call.initialMessage).map((call) => call.commandId)).size,
        ).toBe(1);
        expect(
          (yield* listMetadata(sql)).find((row) => row.threadId === first)?.parentThreadId,
        ).toBe(parentId);
      }).pipe(
        Effect.provideService(ThreadManagementService, {
          getThreadRecords: () =>
            Effect.succeed({
              thread: {
                id: parentId,
                projectId,
                archivedAt: null,
                deletedAt: null,
                modelSelection: { providerInstanceId: "codex", model: "fake" },
                runtimeMode: "full-access",
                interactionMode: "default",
                worktreePath: "/worktree",
                branch: "feature",
              },
            }),
          getThreadShell: (id: ThreadId) =>
            Effect.succeed(
              shells.has(id)
                ? {
                    id,
                    projectId,
                    archivedAt: null,
                    deletedAt: null,
                    latestRunId: started.has(id) ? RunId.make("first") : null,
                  }
                : null,
            ),
          dispatch: () => Effect.succeed({}),
        } as never),
        Effect.provideService(ThreadLaunchService, {
          launch: (input: ThreadLaunchInput) =>
            Effect.gen(function* () {
              calls.push(input);
              shells.add(input.threadId!);
              if (input.initialMessage) {
                const sql = yield* SqlClient.SqlClient;
                const metadata = yield* listMetadata(sql);
                expect(
                  metadata.find((row) => row.threadId === input.threadId)?.parentThreadId,
                ).toBe(parentId);
                expect(input.issue).toBe("https://git.test/brad/tasks/issues/2");
                expect(input.initialMessage.text).toContain("Owner: Specialist");
                expect(input.workspaceStrategy).toEqual({
                  type: "existing_worktree",
                  worktreePath: "/worktree",
                  branch: "feature",
                });
                if (failStart)
                  return yield* new ThreadLaunchError({
                    commandId: input.commandId,
                    projectId,
                    threadId: input.threadId!,
                    operation: "start-issue",
                    cause: "Gitea unavailable",
                  });
                started.add(input.threadId!);
              }
              return { threadId: input.threadId! } as never;
            }),
        } as never),
        Effect.provide(SqlitePersistenceMemory),
      );
    },
  );
});
