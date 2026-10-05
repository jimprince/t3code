import { PROJECT_WIDGET_TYPES, ProjectLayoutError, type ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { ProjectLayoutService } from "../../../projectLayout/ProjectLayoutService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { ProjectLayoutToolkit } from "./tools.ts";

const make = Effect.gen(function* () {
  const layouts = yield* ProjectLayoutService;

  /** Writes are the project orchestrator's alone; workers in its tree read. */
  const requireOrchestrator = (threadId: ThreadId) =>
    layouts.rootOf(threadId).pipe(
      Effect.flatMap((rootThreadId) =>
        rootThreadId === threadId
          ? Effect.void
          : Effect.fail(
              new ProjectLayoutError({
                message:
                  "Only the project's orchestrator can change the layout; ask it to make the change.",
              }),
            ),
      ),
    );

  return ProjectLayoutToolkit.of({
    project_layout_get: () =>
      Effect.gen(function* () {
        const scope = yield* McpInvocationContext.requireMcpCapability("pull-requests");
        const layout = yield* layouts.get(scope.threadId);
        return { revision: layout.revision, layout, widgetTypes: PROJECT_WIDGET_TYPES };
      }),
    project_layout_update: (input) =>
      Effect.gen(function* () {
        const scope = yield* McpInvocationContext.requireMcpCapability("pull-requests");
        yield* requireOrchestrator(scope.threadId);
        const layout = yield* layouts.apply(
          {
            threadId: scope.threadId,
            baseRevision: input.baseRevision,
            ops: input.ops,
            reason: input.reason,
          },
          { kind: "agent", threadId: scope.threadId, reason: input.reason.trim() || null },
        );
        return { layout };
      }),
    project_layout_history: (input) =>
      Effect.gen(function* () {
        const scope = yield* McpInvocationContext.requireMcpCapability("pull-requests");
        return yield* layouts.history({
          threadId: scope.threadId,
          ...(input.limit === undefined ? {} : { limit: input.limit }),
        });
      }),
    project_layout_revert: (input) =>
      Effect.gen(function* () {
        const scope = yield* McpInvocationContext.requireMcpCapability("pull-requests");
        yield* requireOrchestrator(scope.threadId);
        const layout = yield* layouts.revert(
          { threadId: scope.threadId, toRevision: input.revision },
          { kind: "agent", threadId: scope.threadId, reason: null },
        );
        return { layout };
      }),
  });
});

export const ProjectLayoutToolkitHandlersLive = ProjectLayoutToolkit.toLayer(make);
