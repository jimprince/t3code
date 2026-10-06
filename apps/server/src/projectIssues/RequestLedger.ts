import * as Crypto from "effect/Crypto";
import { makeNestingService } from "../forkThreads/NestingService.ts";
import {
  buildDiscussionBrief,
  discussionTitle,
  findDiscussion,
  type DiscussedDecision,
} from "./decisionDiscussion.logic.ts";
import {
  CommandId,
  MessageId,
  ProjectIssuesError,
  type GiteaInstanceConfig,
  type ProjectIssuesListResult,
  type ProjectRequestCreateInput,
  type ProjectRequestDecideInput,
  type ProjectRequestDiscussInput,
  type ProjectRequestRef,
  type ProjectRequestSettleInput,
  type ProjectRequestSubmitInput,
  type ProjectRequestsListInput,
  type ProjectRequestUpdateInput,
  ThreadId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";

import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import * as ServerConfig from "../config.ts";

import { listMetadata } from "../forkThreads/MetadataStore.ts";
import type * as ThreadIssueService from "../forkThreads/ThreadIssueService.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import * as GiteaApi from "../sourceControl/GiteaApi.ts";
import { TextGeneration } from "../textGeneration/TextGeneration.ts";
import type { ProjectIssuesService } from "./ProjectIssuesService.ts";
import type { RequestCandidate, RequestKind } from "../textGeneration/RequestItemsPrompt.ts";
import {
  findRootThreadId,
  REQUEST_LABEL,
  repositoryKey,
  STATUS_LABELS,
  AWAITING_RELEASE_LABEL,
  NEEDS_TEST_LABEL,
  PARKED_LABEL,
  parseBlockedBy,
  type GiteaRepositoryTarget,
} from "./projectIssues.logic.ts";
import { ensureMilestone, setIssueMilestone } from "./giteaMilestones.ts";
import {
  answerToMessage,
  decisionThreadId,
  formatFollowUpComment,
  planDecision,
  planRequestItem,
  progressLineFor,
  requestCandidates,
} from "./requestLedger.logic.ts";
import {
  hasDecisionBlock,
  NEEDS_BRAD_LABEL,
  parseDecisionIssue,
  planBradAnswer,
  resolveWaitingThread,
} from "./decisions.logic.ts";
import {
  fallbackRequestItem,
  formatRequestIssueBody,
  capturableMessage,
  isObviouslyNotARequest,
  parseRequestReference,
  clampTitle,
  REQUEST_LABEL_COLORS,
  BUG_LABEL,
  planKindLabelChange,
  requestKindLabel,
} from "./requestLedger.logic.ts";
import { cleanRequestTitle, deriveRequestTitle, planRetitle } from "./requestTitle.logic.ts";
import {
  enqueue,
  isAlreadyFiled,
  parseOutbox,
  retryDelayMs,
  updateEntry,
  type Outbox,
  type OutboxEntry,
} from "./requestOutbox.logic.ts";

const GiteaLabel = Schema.Struct({ id: Schema.Number, name: Schema.String });
const GiteaLabels = Schema.Array(GiteaLabel);
const CreatedIssue = Schema.Struct({ number: Schema.Number, html_url: Schema.String });
const GiteaIssueLabels = Schema.Struct({
  title: Schema.optional(Schema.String),
  body: Schema.optional(Schema.NullOr(Schema.String)),
  state: Schema.Literals(["open", "closed"]),
  html_url: Schema.String,
  labels: Schema.optional(Schema.NullOr(Schema.Array(Schema.Struct({ name: Schema.String })))),
});
const GiteaComments = Schema.Array(
  Schema.Struct({
    body: Schema.String,
    created_at: Schema.String,
    user: Schema.optional(Schema.NullOr(Schema.Struct({ login: Schema.String }))),
  }),
);

const RECENT_MESSAGE_LIMIT = 500;
type LatestComment = { author: string; body: string; createdAt: string } | null;
/** Each request's newest comment, kept until the issue's updated_at moves (process-wide). */
const latestCommentCache = new Map<string, { updatedAt: string; comment: LatestComment }>();
type Answer = NonNullable<ProjectIssuesListResult["issues"][number]["answer"]>;
/** Found answers never change, so they are kept for the life of the process. */
const answerCache = new Map<string, Answer>();
const COMMENT_EXCERPT_CHARS = 1_200;

/** The issue with its newest comment, and any "Blocked by #N" that comment adds to its body's. */
function withLatestComment(
  issue: ProjectIssuesListResult["issues"][number],
  comment: NonNullable<LatestComment>,
): ProjectIssuesListResult["issues"][number] {
  const blockedBy = [...new Set([...(issue.blockedBy ?? []), ...parseBlockedBy(comment.body)])];
  return { ...issue, latestComment: comment, ...(blockedBy.length > 0 ? { blockedBy } : {}) };
}

const fail = (message: string) => new ProjectIssuesError({ message });

/** One writer for the outbox file across every connection's ledger in this process. */
const discussLock = Semaphore.makeUnsafe(1);
const outboxLock = Semaphore.makeUnsafe(1);
/** Outbox files with a drain loop already running. */
const draining = new Set<string>();
const MAX_ITEMS_PER_MESSAGE = 8;
const encodeOutboxJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

function describeError(error: unknown): string {
  if (typeof error === "object" && error !== null) {
    const record = error as { message?: unknown; detail?: unknown };
    if (typeof record.message === "string" && record.message) return record.message;
    if (typeof record.detail === "string" && record.detail) return record.detail;
  }
  return "Could not file the request.";
}

/**
 * The request ledger: every message Brad types in a UI client is split into the
 * requests it makes, and each request becomes a Gitea issue labeled `ask` in the
 * tracker repository of the thread's project tree, linked to the thread where he
 * asked and to its orchestrator. Brad settles requests from the project page;
 * agents move them through the board's lanes.
 */
export const make = (deps: {
  readonly projectIssues: ProjectIssuesService;
  readonly threadIssues: ThreadIssueService.ThreadIssueService;
}) =>
  Effect.gen(function* () {
    const engine = yield* ThreadManagement.ThreadManagementService;
    const projectService = yield* ProjectService.ProjectService;
    const sql = yield* SqlClient.SqlClient;
    const settings = yield* ServerSettingsService;
    // Optional so hosts without text generation (and narrow test layers) still file requests whole.
    const textGeneration = yield* Effect.serviceOption(TextGeneration);
    const api = yield* GiteaApi.make;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const crypto = yield* Crypto.Crypto;
    const nesting = yield* makeNestingService(sql, engine.getThreadShell, engine.dispatch).pipe(
      Effect.orDie,
    );
    const serverConfig = yield* ServerConfig.ServerConfig;
    const outboxPath = path.join(serverConfig.stateDir, "request-ledger-outbox.json");

    const captured = new Set<string>();

    /** Every thread with its orchestrator parent, which lives in the fork's sidecar. */
    const readThreads = Effect.gen(function* () {
      const snapshot = yield* engine
        .getShellSnapshot()
        .pipe(Effect.mapError(() => fail("Could not read threads.")));
      const parents = new Map(
        (yield* listMetadata(sql).pipe(
          Effect.mapError(() => fail("Could not read thread parents.")),
        )).map((row) => [row.threadId, row.parentThreadId]),
      );
      return [...snapshot.threads, ...snapshot.archivedThreads].map((thread) => ({
        ...thread,
        updatedAt: DateTime.formatIso(thread.updatedAt),
        archivedAt: thread.archivedAt === null ? null : DateTime.formatIso(thread.archivedAt),
        parentThreadId: parents.get(thread.id) ?? null,
      }));
    });
    const labelIds = new Map<string, Map<string, number>>();

    const ensureLabels = (instance: GiteaInstanceConfig, repository: string, names: string[]) =>
      Effect.gen(function* () {
        const key = `${instance.id}:${repository}`;
        let known = labelIds.get(key);
        if (!known || names.some((name) => !known!.has(name))) {
          const labels = yield* api.request(
            instance,
            `${GiteaApi.repositoryPath(repository)}/labels?limit=100`,
            GiteaLabels,
          );
          known = new Map(labels.map((label) => [label.name.toLowerCase(), label.id]));
          labelIds.set(key, known);
        }
        for (const name of names) {
          if (known.has(name)) continue;
          const created = yield* api.request(
            instance,
            `${GiteaApi.repositoryPath(repository)}/labels`,
            GiteaLabel,
            {
              name,
              color: REQUEST_LABEL_COLORS[name] ?? "#5b6ee1",
              description: "Request tracked by the T3 request ledger",
            },
          );
          known.set(created.name.toLowerCase(), created.id);
        }
        return names.map((name) => known!.get(name)!);
      });

    /**
     * Split a message into its requests, each naming the open issue it continues.
     * Without a model the whole message is one item with no `existing`, which
     * later falls back to the thread's newest linked issue.
     */
    const splitMessage = (input: {
      text: string;
      threadTitle: string;
      cwd: string;
      candidates: ReadonlyArray<RequestCandidate>;
    }) =>
      Effect.gen(function* () {
        const config = yield* settings.getSettings;
        const generate = Option.getOrUndefined(textGeneration)?.generateRequestItems;
        if (!generate) return [fallbackRequestItem(input.text)];
        return yield* generate({
          cwd: input.cwd,
          message: input.text,
          threadTitle: input.threadTitle,
          candidates: input.candidates,
          modelSelection: config.textGenerationModelSelection,
        }).pipe(
          Effect.map(
            (
              result,
            ): ReadonlyArray<{
              title: string;
              kind: RequestKind;
              bug?: boolean;
              excerpt: string;
              existing?: number | null;
            }> =>
              result.items.map((item) => ({
                ...item,
                title:
                  cleanRequestTitle(item.title, item.kind) ||
                  deriveRequestTitle(item.excerpt || input.text, item.kind).title,
              })),
          ),
          Effect.catch((error) =>
            Effect.logWarning("request ledger could not split a message; filing it whole", {
              detail: error.detail,
            }).pipe(Effect.as([fallbackRequestItem(input.text)])),
          ),
        );
      });

    /** The thread, its orchestrator root, and the root project's tracker repository. */
    const resolveThread = (threadId: ThreadId) =>
      Effect.gen(function* () {
        const config = yield* settings.getSettings.pipe(
          Effect.mapError(() => fail("Could not read settings.")),
        );
        const threads = yield* readThreads;
        const thread = threads.find((candidate) => candidate.id === threadId);
        if (!thread) return null;
        const rootThreadId = findRootThreadId(threads, thread.id);
        const root = threads.find((candidate) => candidate.id === rootThreadId) ?? thread;
        const project = Option.getOrNull(
          yield* projectService
            .getShell(root.projectId)
            .pipe(Effect.mapError(() => fail("Could not read projects."))),
        );
        if (!project) return null;
        const target = yield* deps.projectIssues.repositoryForProject(
          project,
          config.giteaInstances,
        );
        return target ? { config, thread, root, project, target } : null;
      });

    type Resolved = NonNullable<Effect.Success<ReturnType<typeof resolveThread>>>;

    /** File one request issue and link it to its thread and orchestrator. */
    const fileRequest = (
      resolved: Resolved,
      item: {
        title: string;
        kind: RequestKind;
        bug?: boolean | undefined;
        excerpt: string;
        parked?: boolean;
      },
      messageId: string,
      itemIndex?: number,
    ) =>
      Effect.gen(function* () {
        const { target, thread, root } = resolved;
        const labels = yield* ensureLabels(target.instance, target.repository, [
          REQUEST_LABEL,
          requestKindLabel(item.kind),
          ...(item.bug ? [BUG_LABEL] : []),
          ...(item.parked ? [PARKED_LABEL] : []),
        ]);
        const issue = yield* api.request(
          target.instance,
          `${GiteaApi.repositoryPath(target.repository)}/issues`,
          CreatedIssue,
          {
            title: clampTitle(item.title),
            body: formatRequestIssueBody({
              excerpt: item.excerpt,
              kind: item.kind,
              bug: item.bug,
              threadTitle: thread.title,
              rootTitle: root.id === thread.id ? null : root.title,
              source: {
                threadId: thread.id,
                rootThreadId: root.id,
                messageId,
                ...(itemIndex === undefined ? {} : { item: itemIndex }),
              },
            }),
            labels,
          },
        );
        // Link by the configured web origin, not html_url: Gitea's ROOT_URL can name
        // another host (git.bradleyprince.com vs git.home:3000) than the instance.
        const reference = `${target.instance.webOrigin.replace(/\/$/, "")}/${target.repository}/issues/${issue.number}`;
        for (const linkThreadId of new Set([thread.id, root.id])) {
          yield* deps.threadIssues.link({ threadId: linkThreadId, reference }).pipe(
            Effect.catch((error) =>
              Effect.logWarning("request ledger could not link a request to its thread", {
                issue: reference,
                detail: error.message,
              }),
            ),
          );
        }
        deps.projectIssues.invalidate(target);
        return {
          host: target.host,
          repository: target.repository,
          number: issue.number,
          url: issue.html_url,
        } satisfies ProjectRequestRef;
      });

    const readOutbox = fileSystem.readFileString(outboxPath).pipe(
      Effect.map((contents): Outbox => parseOutbox(contents)),
      Effect.orElseSucceed(() => parseOutbox(null)),
    );

    /** Read, change and durably rewrite the outbox under the process-wide lock. */
    const modifyOutbox = (change: (outbox: Outbox) => Outbox) =>
      outboxLock.withPermit(
        Effect.gen(function* () {
          const next = change(yield* readOutbox);
          yield* writeFileStringAtomically({
            filePath: outboxPath,
            contents: `${encodeOutboxJson(next)}\n`,
          }).pipe(
            Effect.provideService(FileSystem.FileSystem, fileSystem),
            Effect.provideService(Path.Path, path),
          );
          return next;
        }),
      );

    /** Records a chat follow-up on the issue it continues and links the thread to it. */
    const commentFollowUp = (
      resolved: Resolved,
      number: number,
      item: { excerpt: string },
      messageId: string,
      itemIndex: number,
    ) =>
      Effect.gen(function* () {
        const { target, thread } = resolved;
        yield* api.send(
          target.instance,
          "POST",
          `${GiteaApi.repositoryPath(target.repository)}/issues/${number}/comments`,
          {
            body: formatFollowUpComment({
              excerpt: item.excerpt,
              threadTitle: thread.title,
              messageId,
              item: itemIndex,
            }),
          },
        );
        const reference = `${target.instance.webOrigin.replace(/\/$/, "")}/${target.repository}/issues/${number}`;
        yield* deps.threadIssues.link({ threadId: thread.id, reference }).pipe(Effect.ignore);
        deps.projectIssues.invalidate(target);
      });

    /**
     * File one queued message: split it once (the split is saved so a retry never
     * re-asks the model), then act on each item: the New request box files every
     * item; a chat message's follow-ups become comments on the open issue they
     * continue, questions are skipped, and only genuinely new work is filed.
     * Fails when Gitea cannot be reached, leaving the entry queued.
     */
    const fileEntry = (entry: OutboxEntry) =>
      Effect.gen(function* () {
        const threads = yield* readThreads;
        if (!threads.some((thread) => thread.id === entry.threadId)) return "drop";
        const resolved = yield* resolveThread(entry.threadId);
        if (!resolved) return "drop";

        // A fresh read of the tracker: the open issues a follow-up may continue, and
        // the markers that keep a retry after a lost response from filing twice.
        deps.projectIssues.invalidate(resolved.target);
        const listing = yield* deps.projectIssues.list({ rootThreadId: entry.rootThreadId });
        const repository = listing.repositories.find(
          (candidate) => repositoryKey(candidate) === repositoryKey(resolved.target),
        );
        if (!repository || repository.error) {
          return yield* fail(repository?.error ?? "Gitea is unreachable.");
        }
        const trackerIssues = listing.issues.filter(
          (issue) => repositoryKey(issue) === repositoryKey(resolved.target),
        );
        const candidates = requestCandidates(trackerIssues, entry.threadId);

        let items = entry.items;
        if (items === null) {
          const split = yield* splitMessage({
            text: entry.text,
            threadTitle: resolved.thread.title,
            cwd: resolved.thread.worktreePath ?? resolved.project.workspaceRoot,
            candidates: entry.explicit ? [] : candidates,
          });
          const splitItems = split.slice(0, MAX_ITEMS_PER_MESSAGE).map((item) => {
            // Absent only for the unsplit fallback, which then follows the thread's issue.
            const existing = (item as { existing?: number | null }).existing;
            return {
              kind: item.kind,
              ...(item.bug ? { bug: true } : {}),
              title: item.title.trim() || entry.text,
              excerpt: item.excerpt.trim() || entry.text,
              ...(existing === undefined ? {} : { existing }),
            };
          });
          items = splitItems;
          yield* modifyOutbox((outbox) =>
            updateEntry(outbox, entry.messageId, (current) => ({ ...current, items: splitItems })),
          );
        }
        if (items.length === 0) return "done";

        const filed = new Set(entry.filed);
        for (const [index, item] of items.entries()) {
          if (filed.has(index)) continue;
          const plan = planRequestItem(item, {
            explicit: entry.explicit === true,
            candidates,
            unsplit: item.existing === undefined,
          });
          if (plan.action === "comment") {
            yield* commentFollowUp(resolved, plan.number, item, entry.messageId, index).pipe(
              Effect.mapError((error) => fail(error.detail)),
            );
          } else if (
            plan.action === "file" &&
            !isAlreadyFiled(listing.issues, entry.messageId, index)
          ) {
            yield* fileRequest(resolved, item, entry.messageId, index).pipe(
              Effect.mapError((error) => fail(error.detail)),
            );
          }
          filed.add(index);
          yield* modifyOutbox((outbox) =>
            updateEntry(outbox, entry.messageId, (current) => ({
              ...current,
              filed: [...filed],
            })),
          );
        }
        return "done";
      });

    /**
     * Files everything due in the outbox, then sleeps until the next retry, until
     * the outbox is empty. One loop per outbox file; later calls return at once.
     */
    const drain: Effect.Effect<void> = Effect.gen(function* () {
      if (draining.has(outboxPath)) return;
      draining.add(outboxPath);
      yield* Effect.gen(function* () {
        while (true) {
          const outbox = yield* readOutbox;
          if (outbox.entries.length === 0) return;
          const now = yield* Clock.currentTimeMillis;
          for (const entry of outbox.entries.filter(
            (candidate) => candidate.nextAttemptAt <= now,
          )) {
            const outcome = yield* fileEntry(entry).pipe(
              Effect.map(() => ({ ok: true as const })),
              Effect.catch((error) =>
                Effect.succeed({ ok: false as const, message: describeError(error) }),
              ),
              Effect.catchCause(() =>
                Effect.succeed({ ok: false as const, message: "Unexpected error while filing." }),
              ),
            );
            const at = yield* Clock.currentTimeMillis;
            yield* modifyOutbox((current) =>
              updateEntry(current, entry.messageId, (latest) =>
                outcome.ok
                  ? null
                  : {
                      ...latest,
                      attempts: latest.attempts + 1,
                      lastError: outcome.message.slice(0, 300),
                      nextAttemptAt: at + retryDelayMs(latest.attempts + 1),
                    },
              ),
            );
            if (!outcome.ok) {
              yield* Effect.logWarning("request ledger could not file a request; will retry", {
                messageId: entry.messageId,
                attempts: entry.attempts + 1,
              });
            }
          }
          const remaining = (yield* readOutbox).entries;
          if (remaining.length === 0) return;
          const wake = Math.min(...remaining.map((entry) => entry.nextAttemptAt));
          const wait = Math.max(
            5_000,
            Math.min(10 * 60_000, wake - (yield* Clock.currentTimeMillis)),
          );
          yield* Effect.sleep(wait);
        }
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("request ledger outbox drain stopped", { cause: String(cause) }),
        ),
        Effect.ensuring(Effect.sync(() => draining.delete(outboxPath))),
      );
    });

    const startDrain = drain.pipe(Effect.forkDetach, Effect.asVoid);

    /** Saves an issue for later: the parked label keeps it off the Dashboard. */
    const park = (target: Resolved["target"], number: number) =>
      Effect.gen(function* () {
        const [parkedId] = yield* ensureLabels(target.instance, target.repository, [PARKED_LABEL]);
        yield* api.send(
          target.instance,
          "POST",
          `${GiteaApi.repositoryPath(target.repository)}/issues/${number}/labels`,
          { labels: [parkedId] },
        );
      });

    /** Removes the parked label from an issue, when it has one. */
    const unpark = (target: Resolved["target"], number: number) =>
      Effect.gen(function* () {
        const [parkedId] = yield* ensureLabels(target.instance, target.repository, [PARKED_LABEL]);
        yield* api.send(
          target.instance,
          "DELETE",
          `${GiteaApi.repositoryPath(target.repository)}/issues/${number}/labels/${parkedId}`,
        );
      });

    /**
     * Queue one typed message durably, then file it. The message is written to the
     * outbox before any Gitea call, so an outage delays filing but never loses it.
     */
    const queueMessage = (
      input: { threadId: ThreadId; messageId: string; text: string },
      explicit: boolean,
    ) =>
      Effect.gen(function* () {
        const config = yield* settings.getSettings;
        if (!config.requestLedgerEnabled || config.giteaInstances.length === 0) return;
        const threads = yield* readThreads;
        if (!threads.some((thread) => thread.id === input.threadId)) return;
        const now = yield* Clock.currentTimeMillis;
        yield* modifyOutbox((outbox) =>
          enqueue(outbox, {
            messageId: input.messageId,
            threadId: input.threadId,
            rootThreadId: findRootThreadId(threads, input.threadId),
            text: input.text,
            capturedAt: DateTime.formatIso(DateTime.makeUnsafe(now)),
            items: null,
            filed: [],
            attempts: 0,
            lastError: null,
            nextAttemptAt: now,
            ...(explicit ? { explicit: true } : {}),
          }),
        );
        yield* startDrain;
      });

    const capture = (input: { threadId: ThreadId; messageId: string; text: string }) =>
      Effect.gen(function* () {
        if (captured.has(input.messageId) || isObviouslyNotARequest(input.text)) return;
        captured.add(input.messageId);
        if (captured.size > RECENT_MESSAGE_LIMIT) {
          captured.delete(captured.values().next().value!);
        }
        yield* queueMessage(input, false);
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("request ledger capture failed", { cause: String(cause) }),
        ),
      );

    /**
     * The New request box: Brad asked for a tracked request, so the message is
     * queued as explicit before it is sent and every request in it is filed, even
     * a question. The capture of the same message then finds it already queued.
     */
    const submit = (input: ProjectRequestSubmitInput) =>
      queueMessage(
        {
          threadId: input.threadId,
          messageId: input.messageId,
          text: input.text.trim() || "Request with attached images",
        },
        true,
      ).pipe(Effect.mapError(() => fail("Could not queue the request.")));

    const resolveOrFail = (threadId: ThreadId) =>
      resolveThread(threadId).pipe(
        Effect.flatMap((resolved) =>
          resolved
            ? Effect.succeed(resolved)
            : Effect.fail(fail("This thread's project has no Gitea tracker repository.")),
        ),
      );

    /**
     * An agent files a request Brad made of it. When Gitea cannot be reached the
     * request is queued in the outbox (shown as Pending filing) and filed later.
     */
    const create = (input: ProjectRequestCreateInput) =>
      Effect.gen(function* () {
        const item = {
          title: input.title,
          kind: input.kind,
          ...(input.bug ? { bug: true } : {}),
          excerpt: input.detail?.trim() || input.title,
          ...(input.park ? { parked: true } : {}),
        };
        const stamp = yield* Clock.currentTimeMillis;
        const messageId = `agent:${input.threadId}:${stamp}`;
        type Attempt =
          | { readonly kind: "filed"; readonly request: ProjectRequestRef }
          | { readonly kind: "no-tracker" }
          | { readonly kind: "unreachable" };
        const attempt: Attempt = yield* resolveThread(input.threadId).pipe(
          Effect.flatMap((resolved): Effect.Effect<Attempt, unknown> =>
            resolved
              ? fileRequest(resolved, item, messageId, 0).pipe(
                  Effect.map((request): Attempt => ({ kind: "filed", request })),
                )
              : Effect.succeed({ kind: "no-tracker" }),
          ),
          Effect.catch(() => Effect.succeed<Attempt>({ kind: "unreachable" })),
        );
        if (attempt.kind === "filed") return { request: attempt.request, queued: false };
        if (attempt.kind === "no-tracker") {
          return yield* fail(
            "This thread's project has no Gitea tracker repository. Set one with t3-thread project tracker set.",
          );
        }
        const threads = yield* readThreads;
        yield* modifyOutbox((outbox) =>
          enqueue(outbox, {
            messageId,
            threadId: input.threadId,
            rootThreadId: findRootThreadId(threads, input.threadId),
            text: item.excerpt,
            capturedAt: DateTime.formatIso(DateTime.makeUnsafe(stamp)),
            items: [item],
            filed: [],
            attempts: 0,
            lastError: "Gitea is unreachable.",
            nextAttemptAt: stamp + 30_000,
          }),
        ).pipe(Effect.mapError(() => fail("Could not queue the request.")));
        yield* startDrain;
        return { request: null, queued: true };
      });

    /**
     * An agent moves a request through its stages: in progress, ready for Brad,
     * handed over for the release batch, or shipped in a release and waiting for
     * Brad's test. Starting a request links the agent's thread to it, so the
     * dashboard can show which request each worker serves.
     */
    const update = (input: ProjectRequestUpdateInput) =>
      Effect.gen(function* () {
        const resolved = yield* resolveOrFail(input.threadId);
        const reference = parseRequestReference(input.reference, resolved.target);
        if (!reference) return yield* fail("Expected an issue number, owner/repo#N, or issue URL.");
        if (input.status === "needs-test" && !input.release) {
          return yield* fail("A shipped request needs the release it shipped in.");
        }
        const target =
          reference.repository === resolved.target.repository
            ? resolved.target
            : { ...resolved.target, repository: reference.repository };
        const path = `${GiteaApi.repositoryPath(target.repository)}/issues/${reference.number}`;
        const issue = yield* api
          .request(target.instance, path, GiteaIssueLabels)
          .pipe(Effect.mapError((error) => fail(error.detail)));
        const names = new Set((issue.labels ?? []).map((label) => label.name.toLowerCase()));
        // Typing a task is the one change that applies to any tracker issue, open or closed.
        const typeOnly =
          (input.kind !== undefined || input.bug !== undefined || input.title !== undefined) &&
          input.status === undefined &&
          input.comment === undefined &&
          input.release === undefined;
        // Any open tracker issue can move through the stages: agents track work on
        // the issue a thread is linked to, not only on captured requests.
        if (!typeOnly && issue.state === "closed") {
          return yield* fail("That issue is already closed.");
        }
        if (input.title !== undefined) {
          yield* api
            .send(target.instance, "PATCH", path, { title: input.title })
            .pipe(Effect.mapError((error) => fail(error.detail)));
        } else if (!typeOnly && (input.status === "in-progress" || input.status === undefined)) {
          // Starting or linking a captured request replaces Brad's raw words as its
          // title; a title anyone set since is left alone.
          const retitle = planRetitle({
            title: issue.title ?? "",
            body: issue.body,
            kind: names.has("ask:question") && !names.has("ask:task") ? "question" : undefined,
          });
          if (retitle !== null) {
            yield* api.send(target.instance, "PATCH", path, { title: retitle }).pipe(
              Effect.catch((error) =>
                Effect.logWarning("request ledger could not retitle a request", {
                  detail: error.detail,
                }),
              ),
            );
          }
        }
        const kindChange = planKindLabelChange(names, { kind: input.kind, bug: input.bug });
        if (kindChange.add.length > 0 || kindChange.remove.length > 0) {
          const ids = yield* ensureLabels(target.instance, target.repository, [
            ...kindChange.add,
            ...kindChange.remove,
          ]).pipe(Effect.mapError((error) => fail(error.detail)));
          const added = ids.slice(0, kindChange.add.length);
          if (added.length > 0) {
            yield* api
              .send(target.instance, "POST", `${path}/labels`, { labels: added })
              .pipe(Effect.mapError((error) => fail(error.detail)));
          }
          for (const id of ids.slice(kindChange.add.length)) {
            yield* api
              .send(target.instance, "DELETE", `${path}/labels/${id}`)
              .pipe(Effect.mapError((error) => fail(error.detail)));
          }
        }
        const stageLabels = [...STATUS_LABELS, AWAITING_RELEASE_LABEL, NEEDS_TEST_LABEL];
        // Starting work on a parked idea takes it off the shelf.
        if (input.status === "in-progress" && names.has(PARKED_LABEL)) {
          yield* unpark(target, reference.number).pipe(
            Effect.mapError((error) => fail(error.detail)),
          );
        }
        const known =
          input.status === undefined
            ? []
            : yield* ensureLabels(target.instance, target.repository, stageLabels).pipe(
                Effect.mapError((error) => fail(error.detail)),
              );
        for (const [index, name] of input.status === undefined ? [] : stageLabels.entries()) {
          const wanted = name === input.status;
          if (wanted === names.has(name)) continue;
          yield* (
            wanted
              ? api.send(target.instance, "POST", `${path}/labels`, { labels: [known[index]] })
              : api.send(target.instance, "DELETE", `${path}/labels/${known[index]}`)
          ).pipe(Effect.mapError((error) => fail(error.detail)));
        }
        if (input.status === "needs-test" && input.release) {
          const milestone = yield* ensureMilestone(
            api,
            target.instance,
            target.repository,
            input.release,
          ).pipe(Effect.mapError((error) => fail(error.detail)));
          yield* setIssueMilestone(
            api,
            target.instance,
            target.repository,
            reference.number,
            milestone.id,
          ).pipe(Effect.mapError((error) => fail(error.detail)));
          // A shipped release is no longer a roadmap version: close its milestone so the
          // next open one becomes the next release.
          if (milestone.state !== "closed") {
            yield* api
              .send(
                target.instance,
                "PATCH",
                `${GiteaApi.repositoryPath(target.repository)}/milestones/${milestone.id}`,
                { state: "closed" },
              )
              .pipe(Effect.ignore);
          }
        }
        // Every stage change leaves a short progress line on the issue, so the page can
        // show the latest one even when the agent wrote no summary.
        const note = input.comment?.trim() || progressLineFor(input.status);
        if (note) {
          yield* api
            .send(target.instance, "POST", `${path}/comments`, { body: note })
            .pipe(Effect.mapError((error) => fail(error.detail)));
        }
        if (!typeOnly && (input.status === "in-progress" || input.status === undefined)) {
          const url = `${target.instance.webOrigin.replace(/\/$/, "")}/${target.repository}/issues/${reference.number}`;
          yield* deps.threadIssues
            .link({ threadId: input.threadId, reference: url })
            .pipe(Effect.ignore);
        }
        deps.projectIssues.invalidate(target);
        return {
          host: target.host,
          repository: target.repository,
          number: reference.number,
          url: issue.html_url,
        } satisfies ProjectRequestRef;
      });

    /** One short user message to a thread; the server queues or steers it when a run is active. */
    const tellThread = (recipient: { readonly id: ThreadId }, text: string, number: number) =>
      Effect.gen(function* () {
        const stamp = yield* Clock.currentTimeMillis;
        return yield* engine
          .dispatch({
            type: "message.dispatch",
            createdBy: "user",
            creationSource: "server",
            commandId: CommandId.make(`decision:${stamp}:${number}`),
            threadId: recipient.id,
            messageId: MessageId.make(`decision:${stamp}:${number}`),
            text,
            attachments: [],
            deliveryIntent: "auto",
            dispatchMode: { type: "start_immediately" },
          })
          .pipe(Effect.as(recipient.id));
      });

    /**
     * Brad answers a decision issue, in an order that makes a retry safe: his answer is
     * commented on it (the record, not posted again when it is already the newest
     * comment), the needs-brad label comes off so it leaves the Decisions widget, and
     * the thread its decision block says is waiting is told last. A failed step fails
     * with what already happened. The issue stays open.
     */
    const answerDecision = (
      input: ProjectRequestDecideInput,
      target: GiteaRepositoryTarget,
      reference: { readonly number: number },
      issue: typeof GiteaIssueLabels.Type,
    ) =>
      Effect.gen(function* () {
        const path = `${GiteaApi.repositoryPath(target.repository)}/issues/${reference.number}`;
        const ref = `${target.repository}#${reference.number}`;
        const plan = planBradAnswer({
          decision: input.decision === "answer" ? "answer" : "option",
          option: input.option,
          answer: input.answer,
          note: input.reason,
          title: issue.title ?? `#${reference.number}`,
          reference: ref,
          url: issue.html_url,
        });
        if (!plan) return yield* fail("Choose an option or write an answer.");

        const comments = yield* api
          .request(target.instance, `${path}/comments`, GiteaComments)
          .pipe(Effect.mapError((error) => fail(`Could not read ${ref}: ${error.detail}`)));
        if (comments.at(-1)?.body.trim() !== plan.comment) {
          yield* api
            .send(target.instance, "POST", `${path}/comments`, { body: plan.comment })
            .pipe(
              Effect.mapError((error) =>
                fail(`Could not post the answer on ${ref}: ${error.detail}`),
              ),
            );
        }
        const asksBrad = (issue.labels ?? []).some(
          (label) => label.name.toLowerCase() === NEEDS_BRAD_LABEL,
        );
        if (asksBrad) {
          yield* ensureLabels(target.instance, target.repository, [NEEDS_BRAD_LABEL]).pipe(
            Effect.flatMap(([labelId]) =>
              api.send(target.instance, "DELETE", `${path}/labels/${labelId}`),
            ),
            Effect.mapError((error) =>
              fail(`The answer is on ${ref}, but its needs-brad label stayed: ${error.detail}`),
            ),
          );
        }
        deps.projectIssues.invalidate(target);

        const threads = yield* readThreads.pipe(
          Effect.mapError(() => fail(`The answer is on ${ref}, but threads could not be read.`)),
        );
        const waitingId = resolveWaitingThread(
          parseDecisionIssue(issue.body).waiting,
          threads,
          yield* projectService
            .listShells()
            .pipe(
              Effect.mapError(() =>
                fail(`The answer is on ${ref}, but projects could not be read.`),
              ),
            ),
        );
        const recipient = threads.find((thread) => thread.id === waitingId);
        if (!recipient) return { notifiedThreadId: null };
        const notifiedThreadId = yield* tellThread(recipient, plan.message, reference.number).pipe(
          Effect.mapError((error) =>
            fail(
              `The answer is on ${ref}, but ${recipient.title} was not told: ${describeError(error)}`,
            ),
          ),
        );
        return { notifiedThreadId };
      });

    /**
     * Brad decides an item from Needs you. Approve and an option comment, move the
     * issue to in progress and tell the thread on it (the orchestrator when none is
     * linked) to go ahead; Not yet comments his reason and returns it to Pending.
     */
    const decide = (input: ProjectRequestDecideInput) =>
      Effect.gen(function* () {
        const resolved = yield* resolveOrFail(input.threadId);
        const reference = parseRequestReference(input.reference, resolved.target);
        if (!reference) return yield* fail("Expected an issue number, owner/repo#N, or issue URL.");
        const target =
          reference.repository === resolved.target.repository
            ? resolved.target
            : { ...resolved.target, repository: reference.repository };
        const issue = yield* api
          .request(
            target.instance,
            `${GiteaApi.repositoryPath(target.repository)}/issues/${reference.number}`,
            GiteaIssueLabels,
          )
          .pipe(Effect.mapError((error) => fail(error.detail)));
        if (issue.state === "closed") return yield* fail("That issue is already closed.");
        const asksBrad = (issue.labels ?? []).some(
          (label) => label.name.toLowerCase() === NEEDS_BRAD_LABEL,
        );
        if (
          input.decision === "answer" ||
          (input.decision === "option" && (asksBrad || hasDecisionBlock(issue.body)))
        ) {
          return yield* answerDecision(input, target, reference, issue);
        }
        const plan = planDecision({
          decision: input.decision,
          option: input.option,
          reason: input.reason,
          title: issue.title ?? `#${reference.number}`,
          url: issue.html_url,
        });
        if (!plan) return yield* fail("Choose an option to decide with.");

        const threads = yield* readThreads;
        const listed = yield* deps.projectIssues.list({ rootThreadId: resolved.root.id });
        const linked =
          listed.issues.find(
            (candidate) =>
              candidate.repository === reference.repository &&
              candidate.number === reference.number,
          )?.linkedThreadIds ?? [];
        const liveThreadIds = new Set(
          threads.filter((thread) => thread.archivedAt === null).map((thread) => thread.id),
        );
        const recipient = threads.find(
          (thread) => thread.id === decisionThreadId(linked, resolved.root.id, liveThreadIds),
        );

        yield* update({
          threadId: input.threadId,
          reference: input.reference,
          status: plan.status,
          comment: plan.comment,
        });
        if (plan.message === null || !recipient) return { notifiedThreadId: null };

        const notifiedThreadId = yield* tellThread(recipient, plan.message, reference.number).pipe(
          Effect.tapError((error) =>
            Effect.logWarning("could not tell the thread about Brad's decision", {
              detail: String(error),
            }),
          ),
          Effect.orElseSucceed(() => null),
        );
        return { notifiedThreadId };
      });

    /**
     * Brad wants to talk a decision through before answering it. Opens a thread nested
     * under the thread his answer would reach (the needs-brad `waiting:` thread, or for
     * a Needs you item the thread Decide tells), falling back to the orchestrator, with
     * that thread's model, seeded with the question and the command that records the
     * answer the way the Decisions widget does. A live discussion of it is reused.
     */
    const discuss = (input: ProjectRequestDiscussInput) =>
      discussLock.withPermit(
        Effect.gen(function* () {
          const resolved = yield* resolveOrFail(input.threadId);
          const reference = parseRequestReference(input.reference, resolved.target);
          if (!reference) {
            return yield* fail("Expected an issue number, owner/repo#N, or issue URL.");
          }
          const target =
            reference.repository === resolved.target.repository
              ? resolved.target
              : { ...resolved.target, repository: reference.repository };
          const issuePath = `${GiteaApi.repositoryPath(target.repository)}/issues/${reference.number}`;
          const issue = yield* api
            .request(target.instance, issuePath, GiteaIssueLabels)
            .pipe(Effect.mapError((error) => fail(error.detail)));
          if (issue.state === "closed") return yield* fail("That issue is already closed.");
          const asksBrad = (issue.labels ?? []).some(
            (label) => label.name.toLowerCase() === NEEDS_BRAD_LABEL,
          );

          const threads = yield* readThreads;
          const projects = yield* projectService
            .listShells()
            .pipe(Effect.mapError(() => fail("Could not read projects.")));
          const live = threads.filter((thread) => thread.archivedAt === null);
          let ownerId: string | null;
          let decided: DiscussedDecision;
          if (asksBrad) {
            const decision = parseDecisionIssue(issue.body);
            ownerId = resolveWaitingThread(decision.waiting, threads, projects);
            decided = { kind: "needs-brad", decision };
          } else {
            const listed = yield* deps.projectIssues.list({ rootThreadId: resolved.root.id });
            const linked =
              listed.issues.find(
                (candidate) =>
                  candidate.repository === reference.repository &&
                  candidate.number === reference.number,
              )?.linkedThreadIds ?? [];
            ownerId = decisionThreadId(
              linked,
              resolved.root.id,
              new Set(live.map((thread) => thread.id)),
            );
            const comments = yield* api
              .request(target.instance, `${issuePath}/comments`, GiteaComments)
              .pipe(Effect.orElseSucceed(() => []));
            decided = {
              kind: "needs-you",
              comment: comments.at(-1)?.body.slice(0, COMMENT_EXCERPT_CHARS) ?? "",
            };
          }
          const owner = live.find((thread) => thread.id === ownerId) ?? resolved.root;

          const existing = findDiscussion(threads, owner.id, reference.number);
          if (existing) return { threadId: ThreadId.make(existing), created: false };

          const newId = crypto.randomUUIDv4.pipe(
            Effect.mapError(() => fail("Could not create an id.")),
          );
          const threadId = ThreadId.make(yield* newId);
          const title = issue.title ?? `#${reference.number}`;
          yield* engine
            .dispatch({
              type: "thread.create",
              commandId: CommandId.make(yield* newId),
              threadId,
              projectId: owner.projectId,
              title: discussionTitle(reference.number, title),
              modelSelection: owner.modelSelection,
              runtimeMode: owner.runtimeMode,
              interactionMode: "default",
              branch: null,
              worktreePath: null,
              createdBy: "user",
              creationSource: "server",
            })
            .pipe(Effect.mapError(() => fail("Could not create the discussion thread.")));
          yield* nesting
            .update({
              commandId: CommandId.make(yield* newId),
              threadId,
              parentThreadId: owner.id,
              remoteParent: null,
            })
            .pipe(Effect.mapError(() => fail("Could not nest the discussion thread.")));
          const brief = buildDiscussionBrief({
            title,
            url: issue.html_url,
            reference: `${target.repository}#${reference.number}`,
            decided,
            projectThreadId: resolved.root.id,
            owner: { id: owner.id, title: owner.title },
          });
          // The thread exists now, so a failed seed still opens it (empty) rather than
          // failing Discuss.
          yield* tellThread({ id: threadId }, brief, reference.number).pipe(
            Effect.tapError((error) =>
              Effect.logWarning("could not seed the decision discussion thread", {
                detail: String(error),
              }),
            ),
            Effect.ignore,
          );
          return { threadId, created: true };
        }),
      );

    /** The requests of the calling thread's project tree, for agents. */
    const listForThread = (input: ProjectRequestsListInput) =>
      Effect.gen(function* () {
        const threads = yield* readThreads;
        const rootThreadId = findRootThreadId(threads, input.threadId);
        const result = yield* deps.projectIssues.list({ rootThreadId });
        return { ...result, issues: result.issues.filter((issue) => issue.isRequest) };
      });

    /** Capture after a successful dispatch when the command is a message Brad typed. */
    const observeDispatch = (command: object, surface: string | undefined) => {
      const message = capturableMessage(command, surface);
      return message ? capture(message).pipe(Effect.forkDetach, Effect.asVoid) : Effect.void;
    };

    const settle = (input: ProjectRequestSettleInput) =>
      Effect.gen(function* () {
        const project = yield* deps.projectIssues.resolveProject(input.rootThreadId);
        const target = project.targets.find(
          (candidate) => repositoryKey(candidate) === repositoryKey(input),
        );
        if (!target) return yield* fail("That repository is not part of this project.");
        const path = `${GiteaApi.repositoryPath(target.repository)}/issues/${input.number}`;
        yield* api
          .request(target.instance, path, GiteaIssueLabels)
          .pipe(Effect.mapError((error) => fail(error.detail)));
        // Settling closes any of the project's issues from its row; Reopen undoes it.
        yield* api
          .send(target.instance, "PATCH", path, { state: input.reopen ? "open" : "closed" })
          .pipe(Effect.mapError((error) => fail(error.detail)));
        deps.projectIssues.invalidate(target);
        return { settled: !input.reopen };
      });

    /**
     * Adds the newest comment to each request waiting on Brad, and the project's
     * captured requests still queued for filing.
     */
    const decorate = (result: ProjectIssuesListResult, rootThreadId: ThreadId) =>
      Effect.gen(function* () {
        type Pending = {
          entry: OutboxEntry;
          title: string;
          kind: RequestKind | null;
          bug?: boolean;
        };
        const pendingRequests = (yield* readOutbox).entries
          .filter((entry) => entry.rootThreadId === rootThreadId)
          .flatMap((entry): Pending[] =>
            entry.items === null
              ? [{ entry, title: deriveRequestTitle(entry.text).title, kind: null }]
              : entry.items
                  .map((item, index) => ({ item, index }))
                  .filter(({ index }) => !entry.filed.includes(index))
                  .map(({ item }) => ({
                    entry,
                    title: item.title,
                    kind: item.kind,
                    ...(item.bug ? { bug: true } : {}),
                  })),
          )
          .map(({ entry, title, kind, bug }) => ({
            messageId: entry.messageId,
            threadId: entry.threadId,
            title,
            kind,
            ...(bug ? { bug } : {}),
            capturedAt: entry.capturedAt,
            attempts: entry.attempts,
            lastError: entry.lastError,
          }));
        const config = yield* settings.getSettings.pipe(Effect.orElseSucceed(() => null));
        const instances = config?.giteaInstances ?? [];
        const issues = yield* Effect.forEach(
          result.issues,
          (issue) => {
            if (!issue.isRequest || issue.closedAt !== null || issue.comments === 0) {
              return Effect.succeed(issue);
            }
            const instance = instances.find(
              (candidate) => new URL(candidate.webOrigin).host.toLowerCase() === issue.host,
            );
            if (!instance) return Effect.succeed(issue);
            const cacheKey = `${issue.host}/${issue.repository}#${issue.number}`;
            const cached = latestCommentCache.get(cacheKey);
            if (cached && cached.updatedAt === issue.updatedAt) {
              return Effect.succeed(
                cached.comment ? withLatestComment(issue, cached.comment) : issue,
              );
            }
            return api
              .request(
                instance,
                `${GiteaApi.repositoryPath(issue.repository)}/issues/${issue.number}/comments`,
                GiteaComments,
              )
              .pipe(
                Effect.map((comments) => {
                  const latest = comments.at(-1);
                  const comment: LatestComment = latest
                    ? {
                        author: latest.user?.login ?? "",
                        body: latest.body.slice(0, COMMENT_EXCERPT_CHARS),
                        createdAt: latest.created_at,
                      }
                    : null;
                  latestCommentCache.set(cacheKey, { updatedAt: issue.updatedAt, comment });
                  return comment ? withLatestComment(issue, comment) : issue;
                }),
                Effect.orElseSucceed(() => issue),
              );
          },
          { concurrency: 4 },
        );
        return { ...result, issues: yield* withAnswers(issues), pendingRequests };
      });

    /**
     * Adds each open request's own answer: the reply to the message that filed it.
     * A thread's messages are read only when one of its requests has a finished
     * reply that is not cached yet, and at most once per listing.
     */
    const withAnswers = (issues: ReadonlyArray<ProjectIssuesListResult["issues"][number]>) =>
      Effect.gen(function* () {
        const waiting = issues.filter(
          (issue) =>
            issue.isRequest &&
            issue.closedAt === null &&
            issue.requestSource !== null &&
            !answerCache.has(issue.requestSource.messageId),
        );
        if (waiting.length > 0) {
          const shells = new Map(
            (yield* readThreads).map((thread) => [thread.id as string, thread]),
          );
          const threadsToRead = new Set<string>();
          for (const issue of waiting) {
            const shell = shells.get(issue.requestSource!.threadId);
            if (shell && shell.latestRunId !== null && shell.activeRunId === null) {
              threadsToRead.add(shell.id);
            }
          }
          for (const threadId of threadsToRead) {
            const projection = yield* engine
              .getThreadProjection(threadId as ThreadId)
              .pipe(Effect.orElseSucceed(() => null));
            if (projection === null) continue;
            const messages = projection.messages.map((message) => ({
              messageId: message.id as string,
              turnId: message.runId as string | null,
              role: message.role,
              text: message.text,
              isStreaming: message.streaming,
              createdAt: DateTime.formatIso(message.createdAt),
            }));
            for (const issue of waiting) {
              if (issue.requestSource?.threadId !== threadId) continue;
              const answer = answerToMessage(messages, issue.requestSource.messageId);
              if (answer) answerCache.set(issue.requestSource.messageId, answer);
            }
          }
        }
        return issues.map((issue) => {
          const answer = issue.requestSource
            ? answerCache.get(issue.requestSource.messageId)
            : undefined;
          return answer && issue.closedAt === null ? { ...issue, answer } : issue;
        });
      });

    // A restart or a new connection resumes filing anything left in the outbox.
    yield* startDrain;

    return {
      observeDispatch,
      capture,
      settle,
      submit,
      decorate,
      withAnswers,
      create,
      update,
      decide,
      discuss,
      listForThread,
      resolveThread,
      park,
      unpark,
    };
  });

export type RequestLedger = Effect.Success<ReturnType<typeof make>>;
