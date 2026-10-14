import * as IssueBody from "./issueBody.ts";
import {
  ProjectIssuesError,
  type ProjectRequestOrderInput,
  type ProjectRequestOrderResult,
  type ProjectRequestQueueInput,
  type ProjectRequestQueueResult,
  type ProjectRequestNextResult,
  type ProjectIssue,
  type ProjectRequestPlacer,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { GiteaRepositoryTarget } from "./projectIssues.logic.ts";
import { parseRequestReference } from "./requestLedger.logic.ts";
import {
  workstreamNumbers,
  isInProgress,
  planPlacement,
  requestQueue,
  pickNext,
  replaceRankTrailer,
} from "./requestOrder.logic.ts";

/** Adapter to the existing ledger's project resolution and decorated request reads. */
export class RepositoryResolver extends Context.Service<
  RepositoryResolver,
  {
    readonly resolve: (
      threadId: ThreadId,
    ) => Effect.Effect<GiteaRepositoryTarget, ProjectIssuesError>;
    readonly actor: (threadId: ThreadId) => Effect.Effect<ProjectRequestPlacer, ProjectIssuesError>;
    readonly list: (
      threadId: ThreadId,
    ) => Effect.Effect<readonly ProjectIssue[], ProjectIssuesError>;
    readonly changed: (target: GiteaRepositoryTarget) => Effect.Effect<void>;
  }
>()("t3/projectIssues/RequestOrder/RepositoryResolver") {}
export class RequestOrder extends Context.Service<
  RequestOrder,
  {
    readonly place: (
      input: ProjectRequestOrderInput,
    ) => Effect.Effect<ProjectRequestOrderResult, ProjectIssuesError>;
    readonly queue: (
      input: ProjectRequestQueueInput,
    ) => Effect.Effect<ProjectRequestQueueResult, ProjectIssuesError>;
    readonly next: (
      input: ProjectRequestQueueInput,
    ) => Effect.Effect<ProjectRequestNextResult, ProjectIssuesError>;
  }
>()("t3/projectIssues/RequestOrder") {}
const fail = (message: string) => new ProjectIssuesError({ message });
const make = Effect.gen(function* () {
  const { withIssueBodyEditor } = yield* IssueBody.make;
  const resolver = yield* RepositoryResolver;
  const queue = (input: ProjectRequestQueueInput) =>
    Effect.gen(function* () {
      const target = yield* resolver.resolve(input.threadId);
      const issues = yield* resolver.list(input.threadId);
      return requestQueue(
        issues.filter((i) => i.host === target.host && i.repository === target.repository),
        input.epic,
        input.all,
      );
    });
  const place = (input: ProjectRequestOrderInput) =>
    Effect.gen(function* () {
      const target = yield* resolver.resolve(input.threadId);
      const ref = parseRequestReference(input.reference, target);
      if (!ref || ref.repository !== target.repository)
        return yield* fail("Order only items in this project's tracker repository.");
      let wrote = false;
      return yield* withIssueBodyEditor(target, (editIssueBody) =>
        Effect.gen(function* () {
          // Invalidate before listing; another connection may have changed the queue.
          const listed = yield* resolver.list(input.threadId);
          const items = listed.filter(
            (i) => i.host === target.host && i.repository === target.repository,
          );
          const moving = items.find((i) => i.number === ref.number);
          if (!moving || moving.closedAt !== null)
            return yield* fail("That open request was not found.");
          const workstreams = workstreamNumbers(items);
          const epic = workstreams.has(moving.number);
          const openWorkstreams = new Set(
            items
              .filter(
                (i) =>
                  i.closedAt === null && !i.labels.includes("parked") && workstreams.has(i.number),
              )
              .map((i) => i.number),
          );
          const workstreamOf = (issue: ProjectIssue, open: ReadonlySet<number>) =>
            issue.partOf !== undefined && open.has(issue.partOf) ? issue.partOf : null;
          const workstream = epic ? null : workstreamOf(moving, openWorkstreams);
          if (!epic && isInProgress(moving) && input.place.to !== "none")
            return yield* fail("Return in-progress work to the queue before ordering it.");
          const siblings = items.filter(
            (i) =>
              workstreams.has(i.number) === epic &&
              (epic || workstreamOf(i, openWorkstreams) === workstream),
          );
          const relative =
            input.place.to === "before" || input.place.to === "after"
              ? parseRequestReference(input.place.reference, target)
              : null;
          if (relative && relative.repository !== target.repository)
            return yield* fail("The placement reference must be in this repository.");
          if (relative?.number === moving.number)
            return {
              rank: moving.rank ?? null,
              position: moving.position ?? null,
              workstream,
            };
          const actor =
            input.actor === "brad"
              ? { kind: "brad" as const }
              : yield* resolver.actor(input.actorThreadId ?? input.threadId);
          const plan = yield* Effect.try({
            try: () => planPlacement(siblings, moving, input.place, relative?.number, epic),
            catch: (error) => fail(error instanceof Error ? error.message : "Invalid placement."),
          });
          for (const write of plan.writes) {
            wrote = true;
            yield* editIssueBody(write.number, (body) =>
              replaceRankTrailer(
                body,
                write.rank,
                write.number === moving.number ? actor : undefined,
              ),
            );
          }
          return {
            rank: plan.rank,
            position: plan.position,
            workstream,
          };
        }),
      ).pipe(
        Effect.ensuring(
          Effect.suspend(() =>
            wrote ? resolver.changed(target).pipe(Effect.forkDetach, Effect.asVoid) : Effect.void,
          ),
        ),
      );
    });
  return RequestOrder.of({
    place,
    queue,
    next: (input) => queue(input).pipe(Effect.map(pickNext)),
  });
});
export const layer = Layer.effect(RequestOrder, make);
