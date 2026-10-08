import {
  ProjectIssuesError,
  type ProjectIssuesListResult,
  type ProjectPendingAsk,
  type ProjectPendingAsksInput,
  type ProjectRequestApproveMergeInput,
  type ProjectRequestDeferInput,
  type ProjectRequestSendBackInput,
  ThreadId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as ProjectService from "../project/ProjectService.ts";
import * as GiteaApi from "../sourceControl/GiteaApi.ts";
import {
  applyDeferral,
  mergeBlocker,
  ownerOfIssue,
  pendingAsksOfThread,
  planSendBack,
  pullRequestsClosing,
} from "./decisionFeed.logic.ts";
import {
  collectThreadTree,
  findProjectRootThreadId,
  NEEDS_TEST_LABEL,
  repositoryKey,
} from "./projectIssues.logic.ts";
import { readPendingRequests } from "./pendingAsks.query.ts";
import type { GiteaRepositoryTarget } from "./projectIssues.logic.ts";
import type { ProjectIssuesService } from "./ProjectIssuesService.ts";
import type { RequestLedger } from "./RequestLedger.ts";
import { decisionThreadId, parseRequestReference } from "./requestLedger.logic.ts";

const GiteaIssue = Schema.Struct({
  title: Schema.optional(Schema.String),
  body: Schema.optional(Schema.NullOr(Schema.String)),
  state: Schema.Literals(["open", "closed"]),
  html_url: Schema.String,
});
const GiteaComments = Schema.Array(
  Schema.Struct({ body: Schema.String, created_at: Schema.optional(Schema.String) }),
);
const GiteaPullList = Schema.Array(
  Schema.Struct({
    number: Schema.Number,
    title: Schema.String,
    body: Schema.optional(Schema.NullOr(Schema.String)),
    merged: Schema.optional(Schema.Boolean),
  }),
);
const GiteaPull = Schema.Struct({
  number: Schema.Number,
  title: Schema.String,
  state: Schema.String,
  html_url: Schema.String,
  merged: Schema.optional(Schema.Boolean),
  merged_at: Schema.optional(Schema.NullOr(Schema.String)),
  draft: Schema.optional(Schema.Boolean),
  head: Schema.optional(Schema.Struct({ sha: Schema.String })),
  mergeable: Schema.optional(Schema.NullOr(Schema.Boolean)),
  base: Schema.optional(Schema.Struct({ ref: Schema.String })),
});

const GiteaTimeline = Schema.Array(
  Schema.Struct({ type: Schema.String, created_at: Schema.optional(Schema.String) }),
);

const PULL_PAGE_LIMIT = 50;
const PULL_MAX_PAGES = 4;
const ASK_CONCURRENCY = 4;
/** Most waiting threads read for one feed; the shell flag already filtered the rest out. */
const MAX_ASK_THREADS = 50;
/** What a sent-back comment starts with (planSendBack); a pull request merged before it is old news. */
const SENT_BACK_PREFIX = "Brad sent this back";
const WIP_TITLE = /^\s*(?:\[wip\]|wip:)/i;

const fail = (message: string) => new ProjectIssuesError({ message });

/** One writer for the read-edit-write of an issue body across every connection. */
const deferLock = Semaphore.makeUnsafe(1);
/** One approval at a time per issue, so a double tap cannot send two merges. */
const mergeLocks = new Map<string, Semaphore.Semaphore>();
const mergeLockFor = (key: string) => {
  const existing = mergeLocks.get(key);
  if (existing) return existing;
  const created = Semaphore.makeUnsafe(1);
  mergeLocks.set(key, created);
  return created;
};
/** A merge this recent was this approval's own, or a retry of it. */
const OWN_MERGE_WINDOW_MS = 10 * 60_000;

/**
 * The server side of the one Decisions feed: what threads are asking, merging a
 * Review card's pull request, sending a card back, and Later. Cards themselves are
 * built by the clients from the issue list, which `enrich` adds each card's owner to.
 */
export const make = (deps: {
  readonly projectIssues: ProjectIssuesService;
  readonly ledger: RequestLedger;
}) =>
  Effect.gen(function* () {
    const projectService = yield* ProjectService.ProjectService;
    const api = yield* GiteaApi.make;
    const sql = yield* SqlClient.SqlClient;
    const { ledger } = deps;

    const readProjects = projectService
      .listShells()
      .pipe(Effect.mapError(() => fail("Could not read projects.")));

    /**
     * Pending questions and approvals of the project tree's live threads, oldest
     * first. Only threads whose shell says a request is pending are read in full.
     */
    const pendingAsks = (input: ProjectPendingAsksInput) =>
      Effect.gen(function* () {
        const threads = yield* ledger.readThreads;
        const tree = collectThreadTree(threads, findProjectRootThreadId(threads, input.threadId));
        const waiting = tree.filter(
          (thread) => thread.archivedAt === null && thread.pendingRuntimeRequest !== null,
        );
        if (waiting.length === 0) return { asks: [] };
        const projects = yield* readProjects;
        const asks = yield* Effect.forEach(
          waiting
            .toSorted((a, b) => a.updatedAt.localeCompare(b.updatedAt))
            .slice(0, MAX_ASK_THREADS),
          (thread) =>
            readPendingRequests(sql, thread.id).pipe(
              Effect.map((requests) =>
                pendingAsksOfThread(
                  {
                    id: thread.id,
                    title: thread.title,
                    projectTitle:
                      projects.find((project) => project.id === thread.projectId)?.title ?? "",
                  },
                  requests,
                ),
              ),
              Effect.orElseSucceed((): ProjectPendingAsk[] => []),
            ),
          { concurrency: ASK_CONCURRENCY },
        );
        return { asks: asks.flat().toSorted((a, b) => a.createdAt.localeCompare(b.createdAt)) };
      });

    /** The issue a card's reference names, with the tracker it lives in. */
    /** Which issue a card's reference names, and the tracker it lives in; no request made. */
    const locate = (threadId: ThreadId, reference: string) =>
      Effect.gen(function* () {
        const resolved = yield* ledger.resolveOrFail(threadId);
        const parsed = parseRequestReference(reference, resolved.target);
        if (!parsed) return yield* fail("Expected an issue number, owner/repo#N, or issue URL.");
        const target =
          parsed.repository === resolved.target.repository
            ? resolved.target
            : { ...resolved.target, repository: parsed.repository };
        const path = `${GiteaApi.repositoryPath(target.repository)}/issues/${parsed.number}`;
        return { resolved, target, number: parsed.number, path };
      });

    const readIssue = (located: Effect.Success<ReturnType<typeof locate>>) =>
      api.request(located.target.instance, located.path, GiteaIssue).pipe(
        Effect.map((issue) => ({ ...located, issue })),
        Effect.mapError((error) => fail(error.detail)),
      );

    const resolveIssue = (threadId: ThreadId, reference: string) =>
      locate(threadId, reference).pipe(Effect.flatMap(readIssue));

    /** The live worker linked to the issue, else the project's orchestrator. */
    const ownerThread = (
      resolved: { readonly root: { readonly id: ThreadId } },
      target: { readonly host: string; readonly repository: string },
      number: number,
    ) =>
      Effect.gen(function* () {
        const threads = yield* ledger.readThreads;
        // The tree's own links, read from thread shells: no tracker request, and no issue
        // is missed for being old or beyond a page.
        const project = yield* deps.projectIssues.resolveProject(resolved.root.id);
        const linked = project.linkedThreads.get(`${repositoryKey(target)}#${number}`) ?? [];
        const live = new Set(
          threads.filter((thread) => thread.archivedAt === null).map((thread) => thread.id),
        );
        const id = decisionThreadId(linked, resolved.root.id, live);
        const thread = threads.find((candidate) => candidate.id === id) ?? null;
        return { thread, viaOrchestrator: id === resolved.root.id };
      });

    /**
     * The pull request a card merges: the one given, else the open one that closes the
     * issue. When none is open, a merged one that closes it means an earlier approval
     * already merged it, so a retry can finish what was left undone. That merge only
     * counts when it came after the issue was last sent back, or an old merge would
     * settle work that was reopened.
     */
    const pullRequestOf = (
      input: ProjectRequestApproveMergeInput,
      found: Effect.Success<ReturnType<typeof resolveIssue>>,
    ) =>
      Effect.gen(function* () {
        const { target, number, path } = found;
        const pulls = `${GiteaApi.repositoryPath(target.repository)}/pulls`;
        const listPulls = (state: "open" | "closed") =>
          Effect.gen(function* () {
            const all: Array<Schema.Schema.Type<typeof GiteaPullList>[number]> = [];
            for (let page = 1; page <= PULL_MAX_PAGES; page++) {
              const batch = yield* api
                .request(
                  target.instance,
                  `${pulls}?state=${state}&sort=recentupdate&limit=${PULL_PAGE_LIMIT}&page=${page}`,
                  GiteaPullList,
                )
                .pipe(Effect.mapError((error) => fail(error.detail)));
              all.push(...batch);
              if (batch.length < PULL_PAGE_LIMIT) break;
            }
            return all;
          });
        let wanted = input.pullRequest;
        let fromMerged = false;
        if (wanted === undefined) {
          const closing = pullRequestsClosing(yield* listPulls("open"), number, target.repository);
          if (closing.length > 1) {
            return yield* fail(
              `Several open pull requests close #${number} (${closing.map((pr) => `PR ${pr.number}`).join(", ")}). Merge the right one from the pull request itself.`,
            );
          }
          wanted = closing[0]?.number;
        }
        if (wanted === undefined) {
          wanted = pullRequestsClosing(
            (yield* listPulls("closed")).filter((pr) => pr.merged === true),
            number,
            target.repository,
          )[0]?.number;
          fromMerged = wanted !== undefined;
        }
        if (wanted === undefined) {
          return yield* fail(
            `No open pull request closes #${number}. Merge it from the pull request itself.`,
          );
        }
        const pull = yield* readPull(target, wanted);
        if (fromMerged) {
          const comments = yield* api
            .request(target.instance, `${path}/comments`, GiteaComments)
            .pipe(Effect.mapError((error) => fail(error.detail)));
          const sentBack = comments.findLast((comment) =>
            comment.body.startsWith(SENT_BACK_PREFIX),
          )?.created_at;
          const timeline = yield* api
            .request(target.instance, `${path}/timeline`, GiteaTimeline)
            .pipe(Effect.orElseSucceed((): Schema.Schema.Type<typeof GiteaTimeline> => []));
          const reopened = timeline.findLast((event) => event.type === "reopen")?.created_at;
          const mergedAt = pull.merged_at == null ? Number.NaN : Date.parse(pull.merged_at);
          const newest = Math.max(
            ...[sentBack, reopened].flatMap((at) => (at === undefined ? [] : [Date.parse(at)])),
            Number.NEGATIVE_INFINITY,
          );
          if (mergedAt < newest) {
            return yield* fail(
              `No open pull request closes #${number}. PR ${pull.number} was merged before the issue was sent back or reopened.`,
            );
          }
        }
        return pull;
      });

    const readPull = (target: GiteaRepositoryTarget, number: number) =>
      api
        .request(
          target.instance,
          `${GiteaApi.repositoryPath(target.repository)}/pulls/${number}`,
          GiteaPull,
        )
        .pipe(Effect.mapError((error) => fail(`Could not read PR ${number}: ${error.detail}`)));

    /**
     * Brad approves a Review card. The pull request that closes the issue is merged,
     * but only an open, non-draft, mergeable one (anything else changes nothing and
     * returns the reason for the card), at the commit he was shown. The issue is then
     * closed, which is settling it, and the worker that owned it is told. A retry after
     * the merge skips the merge and finishes whatever is left; once everything is done
     * it answers the same and writes nothing.
     */
    const approveAndMerge = (input: ProjectRequestApproveMergeInput) =>
      Effect.gen(function* () {
        const located = yield* locate(input.threadId, input.reference);
        return yield* mergeLockFor(
          `${located.target.instance.id}:${located.target.repository}#${located.number}`,
        ).withPermit(
          Effect.gen(function* () {
            const found = yield* readIssue(located);
            const { target, number, path, issue } = found;
            const ref = `${target.repository}#${number}`;
            const pull = yield* pullRequestOf(input, found);
            const alreadyMerged = pull.merged === true;
            if (!alreadyMerged) {
              if (issue.state === "closed") return yield* fail("That issue is already closed.");
              const blocker = mergeBlocker({
                ...pull,
                base: pull.base?.ref,
                draft: pull.draft === true || WIP_TITLE.test(pull.title),
              });
              if (blocker) return yield* fail(blocker);
              const headSha = input.headSha ?? pull.head?.sha;
              const refused = yield* api
                .send(
                  target.instance,
                  "POST",
                  `${GiteaApi.repositoryPath(target.repository)}/pulls/${pull.number}/merge`,
                  { Do: "merge", ...(headSha === undefined ? {} : { head_commit_id: headSha }) },
                )
                .pipe(
                  Effect.as(null),
                  Effect.catch((error) => Effect.succeed(error)),
                );
              if (refused !== null) {
                // A refusal can follow a merge that landed (a slow response, another tab).
                const again = yield* readPull(target, pull.number).pipe(
                  Effect.orElseSucceed(() => null),
                );
                if (again?.merged !== true) {
                  return yield* fail(
                    refused.status === 405 || refused.status === 409
                      ? `Gitea refused to merge PR ${pull.number}: it conflicts, a required check has not passed, or a commit was pushed after the card was shown. Reload and try again.`
                      : `Could not merge PR ${pull.number}: ${refused.detail}`,
                  );
                }
              }
            }
            // A pull request merged elsewhere long ago, with the issue closed by it, was not this approval's.
            const now = yield* Clock.currentTimeMillis;
            const mergedAt = pull.merged_at == null ? Number.NaN : Date.parse(pull.merged_at);
            if (alreadyMerged && issue.state === "closed" && now - mergedAt > OWN_MERGE_WINDOW_MS) {
              return {
                pullRequest: { number: pull.number, url: pull.html_url },
                alreadyMerged,
                notifiedThreadId: null,
              };
            }
            const note = `Brad approved and merged PR ${pull.number}: ${pull.html_url}`;
            let wrote = false;
            yield* Effect.gen(function* () {
              const comments = yield* api.request(
                target.instance,
                `${path}/comments`,
                GiteaComments,
              );
              if (comments.at(-1)?.body.trim() !== note) {
                yield* api.send(target.instance, "POST", `${path}/comments`, { body: note });
                wrote = true;
              }
              // Gitea closes an issue its merged pull request names; closing it again is harmless.
              if (issue.state === "open") {
                yield* api.send(target.instance, "PATCH", path, { state: "closed" });
                wrote = true;
              }
            }).pipe(
              Effect.mapError((error) =>
                fail(`PR ${pull.number} is merged, but ${ref} was not settled: ${error.detail}`),
              ),
            );
            const result = {
              pullRequest: { number: pull.number, url: pull.html_url },
              alreadyMerged,
            };
            if (!wrote && alreadyMerged) return { ...result, notifiedThreadId: null };
            deps.projectIssues.invalidate(target);
            const { thread, viaOrchestrator } = yield* ownerThread(
              found.resolved,
              target,
              number,
            ).pipe(Effect.orElseSucceed(() => ({ thread: null, viaOrchestrator: true })));
            const notifiedThreadId =
              thread === null || viaOrchestrator
                ? null
                : yield* ledger
                    .tellThread(
                      thread,
                      `Brad approved and merged PR ${pull.number} for ${ref} "${issue.title ?? ""}" (${pull.html_url}). The issue is settled.`,
                      number,
                    )
                    .pipe(Effect.orElseSucceed(() => null));
            return { ...result, notifiedThreadId };
          }),
        );
      });

    /**
     * Brad sends a Review or Test card back with a note. The note is commented on the
     * issue, which returns to in progress (reopened when it was closed), and the thread
     * that owns it is told, or the project's orchestrator when that worker is gone.
     */
    const sendBack = (input: ProjectRequestSendBackInput) =>
      Effect.gen(function* () {
        const found = yield* resolveIssue(input.threadId, input.reference);
        const { target, number, path, issue } = found;
        const ref = `${target.repository}#${number}`;
        const plan = planSendBack({
          note: input.note,
          title: issue.title ?? `#${number}`,
          reference: ref,
          url: issue.html_url,
        });
        if (!plan) return yield* fail("Write what to change.");
        const { thread, viaOrchestrator } = yield* ownerThread(found.resolved, target, number);
        const recipient = thread ?? found.resolved.root;
        if (issue.state === "closed") {
          yield* api
            .send(target.instance, "PATCH", path, { state: "open" })
            .pipe(Effect.mapError((error) => fail(`Could not reopen ${ref}: ${error.detail}`)));
        }
        yield* ledger.update({
          threadId: recipient.id,
          reference: input.reference,
          status: "in-progress",
          comment: plan.comment,
        });
        const notifiedThreadId = yield* ledger.tellThread(recipient, plan.message, number).pipe(
          Effect.tapError((error) =>
            Effect.logWarning("could not tell the thread a card was sent back", {
              detail: String(error),
            }),
          ),
          Effect.orElseSucceed(() => null),
        );
        return { notifiedThreadId, viaOrchestrator };
      });

    /**
     * Later: record on the issue when the card returns, or that it moved to the end.
     * The state is a hidden line in the issue body, so every client reads it from the
     * issue list. Nobody is commented to or messaged.
     */
    const defer = (input: ProjectRequestDeferInput) =>
      deferLock.withPermit(
        Effect.gen(function* () {
          const found = yield* resolveIssue(input.threadId, input.reference);
          const { target, path, issue } = found;
          if (issue.state === "closed") return yield* fail("That issue is already closed.");
          const now = yield* Clock.currentTimeMillis;
          const nowIso = DateTime.formatIso(DateTime.makeUnsafe(now));
          let change: Parameters<typeof applyDeferral>[1];
          if (input.mode === "until") {
            const until = input.until === undefined ? Number.NaN : Date.parse(input.until);
            if (Number.isNaN(until) || until <= now)
              return yield* fail("Pick a time in the future.");
            change = { mode: "until", until: DateTime.formatIso(DateTime.makeUnsafe(until)) };
          } else {
            change = input.mode === "end" ? { mode: "end", now: nowIso } : { mode: "clear" };
          }
          const next = applyDeferral(issue.body, change);
          if (next.body !== (issue.body ?? "")) {
            yield* api
              .send(target.instance, "PATCH", path, { body: next.body })
              .pipe(Effect.mapError((error) => fail(error.detail)));
            deps.projectIssues.invalidate(target);
          }
          return {
            until: next.deferral?.until ?? null,
            movedToEndAt: next.deferral?.movedToEndAt ?? null,
          };
        }),
      );

    /**
     * Adds the owner (the thread that gets Brad's answer, and its project) to each open
     * card for Brad: a decision, an item for review or test, or an answered question.
     */
    const enrich = (result: ProjectIssuesListResult, rootThreadId: ThreadId) =>
      Effect.gen(function* () {
        const forBrad = (issue: ProjectIssuesListResult["issues"][number]) =>
          issue.closedAt === null &&
          (issue.decision !== undefined ||
            issue.status === "needs-review" ||
            issue.answer !== undefined ||
            issue.labels.some((label) => label.toLowerCase() === NEEDS_TEST_LABEL));
        if (!result.issues.some(forBrad)) return result;
        const threads = yield* ledger.readThreads;
        const projects = yield* readProjects;
        return {
          ...result,
          issues: result.issues.map((issue) => {
            if (!forBrad(issue)) return issue;
            const owner = ownerOfIssue({
              waiting: issue.decision?.waiting ?? null,
              linkedThreadIds: issue.linkedThreadIds,
              rootThreadId,
              threads,
              projects,
            });
            return owner === null ? issue : { ...issue, owner };
          }),
        };
      });

    return { pendingAsks, approveAndMerge, sendBack, defer, enrich };
  });

export type DecisionFeed = Effect.Success<ReturnType<typeof make>>;
