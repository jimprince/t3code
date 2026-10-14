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
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as GiteaApi from "../sourceControl/GiteaApi.ts";
import type { GiteaRepositoryTarget } from "./projectIssues.logic.ts";
import { parseRequestReference } from "./requestLedger.logic.ts";
import {
  workstreamNumbers,
  isInProgress,
  compareOrder,
  compareRank,
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
const locks = new Map<string, Semaphore.Semaphore>();
const fail = (message: string) => new ProjectIssuesError({ message });
const IssueBody = Schema.Struct({
  body: Schema.optional(Schema.NullOr(Schema.String)),
  state: Schema.String,
  pull_request: Schema.optional(Schema.Unknown),
});
const make = Effect.gen(function* () {
  const resolver = yield* RepositoryResolver;
  const api = yield* GiteaApi.make;
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
      const key = `${target.host}/${target.repository}`;
      let lock = locks.get(key);
      if (!lock) {
        lock = Semaphore.makeUnsafe(1);
        locks.set(key, lock);
      }
      let wrote = false;
      return yield* lock.withPermit(
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
              .filter((i) => i.closedAt === null && workstreams.has(i.number))
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
            const path = `${GiteaApi.repositoryPath(target.repository)}/issues/${write.number}`;
            // Re-read immediately before PATCH so checklist edits since listing are preserved.
            let before = yield* api
              .request(target.instance, path, IssueBody)
              .pipe(Effect.mapError((e) => fail(e.detail)));
            if (before.state !== "open" || before.pull_request != null)
              return yield* fail("Only open issues can be ordered.");
            for (let attempt = 0; attempt < 2; attempt++) {
              const body = replaceRankTrailer(
                before.body ?? "",
                write.rank,
                write.number === moving.number ? actor : undefined,
              );
              wrote = true;
              yield* api
                .send(target.instance, "PATCH", path, { body })
                .pipe(Effect.mapError((e) => fail(e.detail)));
              const after = yield* api
                .request(target.instance, path, IssueBody)
                .pipe(Effect.mapError((e) => fail(e.detail)));
              if ((after.body ?? "") === body) break;
              if (attempt === 1)
                return yield* fail("The issue body changed while saving order; retry the move.");
              before = after;
            }
          }
          // Read back the actual total order, including a concurrent server's equal rank.
          const saved = yield* resolver.list(input.threadId);
          const moved = saved.find(
            (i) =>
              i.host === target.host &&
              i.repository === target.repository &&
              i.number === moving.number,
          );
          const savedWorkstreams = workstreamNumbers(saved);
          const savedOpenWorkstreams = new Set(
            saved
              .filter((i) => i.closedAt === null && savedWorkstreams.has(i.number))
              .map((i) => i.number),
          );
          const savedWorkstream = epic ? null : workstreamOf(moved ?? moving, savedOpenWorkstreams);
          const ordered = saved
            .filter(
              (i) =>
                i.host === target.host &&
                i.repository === target.repository &&
                i.closedAt === null &&
                (epic || !isInProgress(i)) &&
                !i.labels.includes("parked") &&
                i.rank != null &&
                savedWorkstreams.has(i.number) === epic &&
                (epic || workstreamOf(i, savedOpenWorkstreams) === savedWorkstream),
            )
            .toSorted(epic ? compareRank : compareOrder);
          const position = ordered.findIndex((i) => i.number === moving.number) + 1;
          return {
            rank: moved?.rank ?? plan.rank,
            position: plan.rank === null || position === 0 ? null : position,
            workstream: savedWorkstream,
          };
        }).pipe(
          Effect.ensuring(Effect.suspend(() => (wrote ? resolver.changed(target) : Effect.void))),
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
