import {
  ProjectIssuesError,
  type GiteaInstanceConfig,
  type ProjectIssuesListResult,
  type ProjectRequestCreateInput,
  type ProjectRequestRef,
  type ProjectRequestSettleInput,
  type ProjectRequestsListInput,
  type ProjectRequestUpdateInput,
  type ThreadId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { writeFileStringAtomically } from "../atomicWrite.ts";
import * as ServerConfig from "../config.ts";

import { listMetadata } from "../forkThreads/MetadataStore.ts";
import type * as ThreadIssueService from "../forkThreads/ThreadIssueService.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import * as GiteaApi from "../sourceControl/GiteaApi.ts";
import { TextGeneration } from "../textGeneration/TextGeneration.ts";
import type { ProjectIssuesService } from "./ProjectIssuesService.ts";
import type { RequestKind } from "../textGeneration/RequestItemsPrompt.ts";
import {
  findRootThreadId,
  REQUEST_LABEL,
  repositoryKey,
  STATUS_LABELS,
  AWAITING_RELEASE_LABEL,
  NEEDS_TEST_LABEL,
} from "./projectIssues.logic.ts";
import { ensureMilestone, setIssueMilestone } from "./giteaMilestones.ts";
import {
  fallbackRequestItem,
  formatRequestIssueBody,
  capturableMessage,
  isObviouslyNotARequest,
  parseRequestReference,
  clampTitle,
  REQUEST_LABEL_COLORS,
  requestKindLabel,
} from "./requestLedger.logic.ts";
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
const COMMENT_EXCERPT_CHARS = 1_200;

const fail = (message: string) => new ProjectIssuesError({ message });

/** One writer for the outbox file across every connection's ledger in this process. */
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

    const splitMessage = (input: { text: string; threadTitle: string; cwd: string }) =>
      Effect.gen(function* () {
        const config = yield* settings.getSettings;
        const generate = Option.getOrUndefined(textGeneration)?.generateRequestItems;
        if (!generate) return [fallbackRequestItem(input.text)];
        return yield* generate({
          cwd: input.cwd,
          message: input.text,
          threadTitle: input.threadTitle,
          modelSelection: config.textGenerationModelSelection,
        }).pipe(
          Effect.map((result) => result.items),
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
      item: { title: string; kind: RequestKind; excerpt: string },
      messageId: string,
      itemIndex?: number,
    ) =>
      Effect.gen(function* () {
        const { target, thread, root } = resolved;
        const labels = yield* ensureLabels(target.instance, target.repository, [
          REQUEST_LABEL,
          requestKindLabel(item.kind),
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

    /**
     * File one queued message: split it once (the split is saved so a retry never
     * re-asks the model), then file each request that is not already in the
     * tracker. Fails when Gitea cannot be reached, leaving the entry queued.
     */
    const fileEntry = (entry: OutboxEntry) =>
      Effect.gen(function* () {
        const threads = yield* readThreads;
        if (!threads.some((thread) => thread.id === entry.threadId)) return "drop";
        const resolved = yield* resolveThread(entry.threadId);
        if (!resolved) return "drop";

        let items = entry.items;
        if (items === null) {
          const split = yield* splitMessage({
            text: entry.text,
            threadTitle: resolved.thread.title,
            cwd: resolved.thread.worktreePath ?? resolved.project.workspaceRoot,
          });
          const splitItems = split.slice(0, MAX_ITEMS_PER_MESSAGE).map((item) => ({
            kind: item.kind,
            title: item.title.trim() || entry.text,
            excerpt: item.excerpt.trim() || entry.text,
          }));
          items = splitItems;
          yield* modifyOutbox((outbox) =>
            updateEntry(outbox, entry.messageId, (current) => ({ ...current, items: splitItems })),
          );
        }
        if (items.length === 0) return "done";

        // A fresh read of the tracker: anything already filed for this message is
        // recognised by its marker, so a retry after a lost response files nothing twice.
        deps.projectIssues.invalidate(resolved.target);
        const listing = yield* deps.projectIssues.list({ rootThreadId: entry.rootThreadId });
        const repository = listing.repositories.find(
          (candidate) => repositoryKey(candidate) === repositoryKey(resolved.target),
        );
        if (!repository || repository.error) {
          return yield* fail(repository?.error ?? "Gitea is unreachable.");
        }
        const filed = new Set(entry.filed);
        for (const [index, item] of items.entries()) {
          if (filed.has(index)) continue;
          if (!isAlreadyFiled(listing.issues, entry.messageId, index)) {
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

    /**
     * Queue one typed message durably, then file it. The message is written to the
     * outbox before any Gitea call, so an outage delays filing but never loses it.
     */
    const capture = (input: { threadId: ThreadId; messageId: string; text: string }) =>
      Effect.gen(function* () {
        if (captured.has(input.messageId) || isObviouslyNotARequest(input.text)) return;
        captured.add(input.messageId);
        if (captured.size > RECENT_MESSAGE_LIMIT) {
          captured.delete(captured.values().next().value!);
        }
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
          }),
        );
        yield* startDrain;
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("request ledger capture failed", { cause: String(cause) }),
        ),
      );

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
          excerpt: input.detail?.trim() || input.title,
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
        if (!names.has(REQUEST_LABEL)) return yield* fail("That issue is not a request.");
        if (issue.state === "closed") return yield* fail("That request is already settled.");
        const stageLabels = [...STATUS_LABELS, AWAITING_RELEASE_LABEL, NEEDS_TEST_LABEL];
        const known = yield* ensureLabels(target.instance, target.repository, stageLabels).pipe(
          Effect.mapError((error) => fail(error.detail)),
        );
        for (const [index, name] of stageLabels.entries()) {
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
        if (input.comment?.trim()) {
          yield* api
            .send(target.instance, "POST", `${path}/comments`, { body: input.comment.trim() })
            .pipe(Effect.mapError((error) => fail(error.detail)));
        }
        if (input.status === "in-progress") {
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
        const issue = yield* api
          .request(target.instance, path, GiteaIssueLabels)
          .pipe(Effect.mapError((error) => fail(error.detail)));
        if (!(issue.labels ?? []).some((label) => label.name.toLowerCase() === REQUEST_LABEL)) {
          return yield* fail("Only requests can be settled here.");
        }
        yield* api
          .send(target.instance, "PATCH", path, { state: "closed" })
          .pipe(Effect.mapError((error) => fail(error.detail)));
        deps.projectIssues.invalidate(target);
        return { settled: true };
      });

    /**
     * Adds the newest comment to each request waiting on Brad, and the project's
     * captured requests still queued for filing.
     */
    const decorate = (result: ProjectIssuesListResult, rootThreadId: ThreadId) =>
      Effect.gen(function* () {
        type Pending = { entry: OutboxEntry; title: string; kind: RequestKind | null };
        const pendingRequests = (yield* readOutbox).entries
          .filter((entry) => entry.rootThreadId === rootThreadId)
          .flatMap((entry): Pending[] =>
            entry.items === null
              ? [{ entry, title: entry.text.split("\n")[0]!.slice(0, 120), kind: null }]
              : entry.items
                  .map((item, index) => ({ item, index }))
                  .filter(({ index }) => !entry.filed.includes(index))
                  .map(({ item }) => ({ entry, title: item.title, kind: item.kind })),
          )
          .map(({ entry, title, kind }) => ({
            messageId: entry.messageId,
            threadId: entry.threadId,
            title,
            kind,
            capturedAt: entry.capturedAt,
            attempts: entry.attempts,
            lastError: entry.lastError,
          }));
        const config = yield* settings.getSettings.pipe(Effect.orElseSucceed(() => null));
        const instances = config?.giteaInstances ?? [];
        const issues = yield* Effect.forEach(
          result.issues,
          (issue) => {
            if (!issue.isRequest || issue.status !== "needs-review" || issue.comments === 0) {
              return Effect.succeed(issue);
            }
            const instance = instances.find(
              (candidate) => new URL(candidate.webOrigin).host.toLowerCase() === issue.host,
            );
            if (!instance) return Effect.succeed(issue);
            return api
              .request(
                instance,
                `${GiteaApi.repositoryPath(issue.repository)}/issues/${issue.number}/comments`,
                GiteaComments,
              )
              .pipe(
                Effect.map((comments) => {
                  const latest = comments.at(-1);
                  return latest
                    ? {
                        ...issue,
                        latestComment: {
                          author: latest.user?.login ?? "",
                          body: latest.body.slice(0, COMMENT_EXCERPT_CHARS),
                          createdAt: latest.created_at,
                        },
                      }
                    : issue;
                }),
                Effect.orElseSucceed(() => issue),
              );
          },
          { concurrency: 4 },
        );
        return { ...result, issues, pendingRequests };
      });

    // A restart or a new connection resumes filing anything left in the outbox.
    yield* startDrain;

    return {
      observeDispatch,
      capture,
      settle,
      decorate,
      create,
      update,
      listForThread,
      resolveThread,
    };
  });

export type RequestLedger = Effect.Success<ReturnType<typeof make>>;
