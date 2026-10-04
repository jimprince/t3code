import {
  ProjectIssuesError,
  type GiteaInstanceConfig,
  type OrchestrationCommand,
  type ProjectIssuesListResult,
  type ProjectRequestCreateInput,
  type ProjectRequestRef,
  type ProjectRequestSettleInput,
  type ProjectRequestsListInput,
  type ProjectRequestUpdateInput,
  type ThreadId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type * as ThreadIssueService from "../orchestration/ThreadIssueService.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
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
} from "./projectIssues.logic.ts";
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
    const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
    const settings = yield* ServerSettingsService;
    // Optional so hosts without text generation (and narrow test layers) still file requests whole.
    const textGeneration = yield* Effect.serviceOption(TextGeneration);
    const api = yield* GiteaApi.make;

    const captured = new Set<string>();
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
        const snapshot = yield* snapshots
          .getShellSnapshot()
          .pipe(Effect.mapError(() => fail("Could not read threads.")));
        const thread = snapshot.threads.find((candidate) => candidate.id === threadId);
        if (!thread) return null;
        const rootThreadId = findRootThreadId(snapshot.threads, thread.id);
        const root = snapshot.threads.find((candidate) => candidate.id === rootThreadId) ?? thread;
        const project = snapshot.projects.find((candidate) => candidate.id === root.projectId);
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
              source: { threadId: thread.id, rootThreadId: root.id, messageId },
            }),
            labels,
          },
        );
        for (const linkThreadId of new Set([thread.id, root.id])) {
          yield* deps.threadIssues
            .link({ threadId: linkThreadId, reference: issue.html_url })
            .pipe(Effect.ignore);
        }
        deps.projectIssues.invalidate(target);
        return {
          host: target.host,
          repository: target.repository,
          number: issue.number,
          url: issue.html_url,
        } satisfies ProjectRequestRef;
      });

    /** Split one typed message and file its requests. Never fails; problems are logged. */
    const capture = (input: { threadId: ThreadId; messageId: string; text: string }) =>
      Effect.gen(function* () {
        if (captured.has(input.messageId) || isObviouslyNotARequest(input.text)) return;
        captured.add(input.messageId);
        if (captured.size > RECENT_MESSAGE_LIMIT) {
          captured.delete(captured.values().next().value!);
        }
        const config = yield* settings.getSettings;
        if (!config.requestLedgerEnabled || config.giteaInstances.length === 0) return;
        const resolved = yield* resolveThread(input.threadId);
        if (!resolved) return;
        const items = yield* splitMessage({
          text: input.text,
          threadTitle: resolved.thread.title,
          cwd: resolved.thread.worktreePath ?? resolved.project.workspaceRoot,
        });
        for (const item of items.slice(0, 8)) {
          yield* fileRequest(
            resolved,
            {
              kind: item.kind,
              title: item.title.trim() || input.text,
              excerpt: item.excerpt.trim() || input.text,
            },
            input.messageId,
          );
        }
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

    /** An agent files a request Brad made of it. */
    const create = (input: ProjectRequestCreateInput) =>
      Effect.gen(function* () {
        const resolved = yield* resolveOrFail(input.threadId);
        const stamp = yield* Clock.currentTimeMillis;
        return yield* fileRequest(
          resolved,
          { title: input.title, kind: input.kind, excerpt: input.detail?.trim() || input.title },
          `agent:${input.threadId}:${stamp}`,
        ).pipe(Effect.mapError((error) => fail(error.detail)));
      });

    /** An agent moves a request between pending, in progress and ready for Brad. */
    const update = (input: ProjectRequestUpdateInput) =>
      Effect.gen(function* () {
        const resolved = yield* resolveOrFail(input.threadId);
        const reference = parseRequestReference(input.reference, resolved.target);
        if (!reference) return yield* fail("Expected an issue number, owner/repo#N, or issue URL.");
        const target =
          reference.repository === resolved.target.repository
            ? resolved.target
            : { ...resolved.target, repository: reference.repository };
        const path = `${GiteaApi.repositoryPath(target.repository)}/issues/${reference.number}`;
        const issue = yield* api
          .request(target.instance, path, GiteaIssueLabels)
          .pipe(Effect.mapError((error) => fail(error.detail)));
        const names = (issue.labels ?? []).map((label) => label.name.toLowerCase());
        if (!names.includes(REQUEST_LABEL)) return yield* fail("That issue is not a request.");
        if (issue.state === "closed") return yield* fail("That request is already settled.");
        const known = yield* ensureLabels(target.instance, target.repository, [
          ...STATUS_LABELS,
        ]).pipe(Effect.mapError((error) => fail(error.detail)));
        for (const [index, name] of STATUS_LABELS.entries()) {
          const wanted = name === input.status;
          if (wanted === names.includes(name)) continue;
          yield* (
            wanted
              ? api.send(target.instance, "POST", `${path}/labels`, { labels: [known[index]] })
              : api.send(target.instance, "DELETE", `${path}/labels/${known[index]}`)
          ).pipe(Effect.mapError((error) => fail(error.detail)));
        }
        if (input.comment?.trim()) {
          yield* api
            .send(target.instance, "POST", `${path}/comments`, { body: input.comment.trim() })
            .pipe(Effect.mapError((error) => fail(error.detail)));
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
        const snapshot = yield* snapshots
          .getShellSnapshot()
          .pipe(Effect.mapError(() => fail("Could not read threads.")));
        const rootThreadId = findRootThreadId(snapshot.threads, input.threadId);
        const result = yield* deps.projectIssues.list({ rootThreadId });
        return { ...result, issues: result.issues.filter((issue) => issue.isRequest) };
      });

    /** Capture after a successful dispatch when the command is a message Brad typed. */
    const observeDispatch = (command: OrchestrationCommand, surface: string | undefined) => {
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

    /** Adds the newest comment to each request that is waiting on Brad. */
    const withLatestComments = (result: ProjectIssuesListResult) =>
      Effect.gen(function* () {
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
        return { ...result, issues };
      });

    return { observeDispatch, capture, settle, withLatestComments, create, update, listForThread };
  });

export type RequestLedger = Effect.Success<ReturnType<typeof make>>;
