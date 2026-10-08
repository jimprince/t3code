import { type ThreadId, ProjectIssuesError } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ThreadIssues from "../forkThreads/ThreadIssueService.ts";
import * as ProjectIssues from "./ProjectIssuesService.ts";
import * as RequestLedger from "./RequestLedger.ts";

/** The launch gate: the task must be recorded before its worker can start. */
export class TaskIssueLaunchService extends Context.Service<
  TaskIssueLaunchService,
  {
    readonly start: (input: {
      readonly threadId: ThreadId;
      readonly reference: string;
    }) => Effect.Effect<void, ProjectIssuesError>;
  }
>()("t3/projectIssues/TaskIssueLaunchService") {}

export const layer = Layer.effect(
  TaskIssueLaunchService,
  Effect.gen(function* () {
    const threadIssues = yield* ThreadIssues.make;
    const projectIssues = yield* ProjectIssues.make;
    const ledger = yield* RequestLedger.make({ threadIssues, projectIssues });
    return TaskIssueLaunchService.of({
      start: (input) => ledger.update({ ...input, status: "in-progress" }).pipe(Effect.asVoid),
    });
  }),
);
