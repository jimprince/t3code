import {
  CommandId,
  ThreadId,
  ThreadIssueOperationError,
  type GiteaInstanceConfig,
  type OrchestrationProjectShell,
  type ThreadIssueKey,
  type ThreadIssueLink,
  type ThreadIssueSnapshot,
} from "@t3tools/contracts";
import { resolveGiteaRemote } from "@t3tools/shared/sourceControl";
import { threadIssueKeysEqual } from "@t3tools/shared/threadIssues";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { ServerSettingsService } from "../serverSettings.ts";
import * as GiteaApi from "../sourceControl/GiteaApi.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";

export const GiteaIssue = Schema.Struct({
  number: Schema.Number,
  title: Schema.String,
  state: Schema.Literals(["open", "closed"]),
  html_url: Schema.String,
  pull_request: Schema.optional(Schema.Unknown),
});
export type GiteaIssue = typeof GiteaIssue.Type;
const isThreadIssueOperationError = Schema.is(ThreadIssueOperationError);

export interface ResolvedIssueTarget extends ThreadIssueKey {
  readonly instance: GiteaInstanceConfig;
  readonly url: string;
}

export function buildThreadIssueLink(
  target: ResolvedIssueTarget,
  issue: {
    readonly title: string;
    readonly state: "open" | "closed";
    readonly html_url: string;
  } | null,
  linkedAt: string,
): ThreadIssueLink {
  return {
    host: target.host,
    repository: target.repository,
    number: target.number,
    // Keep the URL the user linked. The configured API may be an internal alias
    // whose html_url is not reachable from the client device.
    url: target.url,
    linkedAt,
    snapshot: {
      title: issue?.title ?? `${target.repository} #${target.number}`,
      state: issue?.state ?? "open",
      syncedAt: linkedAt,
    },
  };
}

export function isPullRequestIssue(issue: GiteaIssue): boolean {
  return issue.pull_request != null;
}

type IssueApi = Pick<Effect.Success<typeof GiteaApi.make>, "request">;

/** Metadata always travels through the matched instance, whose apiOrigin may be an internal alias. */
export const fetchThreadIssueMetadata = (api: IssueApi, target: ResolvedIssueTarget) =>
  api.request(
    target.instance,
    `${GiteaApi.repositoryPath(target.repository)}/issues/${target.number}`,
    GiteaIssue,
  );

const fail = (message: string) => new ThreadIssueOperationError({ message });

function instanceForUrl(instances: readonly GiteaInstanceConfig[], url: URL) {
  const hostname = url.hostname.toLowerCase();
  const matches = instances.filter((instance) =>
    [instance.host, ...instance.sshAliases, new URL(instance.webOrigin).hostname].some(
      (candidate) => candidate.toLowerCase() === hostname,
    ),
  );
  return matches.length === 1 ? matches[0]! : null;
}

function parseIssuePath(pathname: string): { repository: string; number: number } | null {
  const match = /^\/([^/]+)\/([^/]+)\/issues\/([1-9]\d*)\/?$/.exec(pathname);
  return match
    ? {
        repository: `${decodeURIComponent(match[1]!)}/${decodeURIComponent(match[2]!)}`,
        number: Number(match[3]),
      }
    : null;
}

function projectTarget(
  project: Pick<OrchestrationProjectShell, "repositoryIdentity">,
  instances: readonly GiteaInstanceConfig[],
): { instance: GiteaInstanceConfig; repository: string } | null {
  const identity = project.repositoryIdentity;
  if (identity?.provider !== "gitea") return null;
  const repository =
    identity.owner && identity.name
      ? `${identity.owner}/${identity.name}`
      : identity.canonicalKey.split("/").slice(1).join("/");
  const host = identity.canonicalKey.split("/")[0]?.toLowerCase();
  const remoteMatch = resolveGiteaRemote(identity.locator.remoteUrl, instances);
  const instance =
    remoteMatch?.instance ??
    instances.find(
      (candidate) =>
        candidate.host.toLowerCase() === host ||
        new URL(candidate.webOrigin).host.toLowerCase() === host,
    );
  return instance && repository.includes("/") ? { instance, repository } : null;
}

function parseCanonicalIssueUrl(reference: string) {
  if (!URL.canParse(reference)) return null;
  const url = new URL(reference);
  if (url.username || url.password || url.search || url.hash) return null;
  const parsed = parseIssuePath(url.pathname);
  return parsed ? { url, ...parsed } : null;
}

/**
 * A canonical issue URL on a host no instance or project names, such as a public
 * HTTPS alias of an internal instance. The host proves nothing, so each instance
 * is a candidate that the caller must confirm through its API.
 */
function aliasIssueCandidates(
  reference: string,
  instances: readonly GiteaInstanceConfig[],
): ResolvedIssueTarget[] {
  const canonical = parseCanonicalIssueUrl(reference);
  if (!canonical || !/^https?:$/.test(canonical.url.protocol)) return [];
  return instances.map((instance) => ({
    instance,
    host: new URL(instance.webOrigin).host.toLowerCase(),
    repository: canonical.repository.toLowerCase(),
    number: canonical.number,
    url: `${canonical.url.origin}/${canonical.repository}/issues/${canonical.number}`,
  }));
}

/** The link a canonical issue URL names, matched by what was stored when it was linked. */
function linkedIssueForUrl(reference: string, links: readonly ThreadIssueLink[] | undefined) {
  const canonical = parseCanonicalIssueUrl(reference);
  if (!canonical) return undefined;
  const repository = canonical.repository.toLowerCase();
  return links?.find(
    (link) =>
      link.number === canonical.number &&
      link.repository === repository &&
      URL.canParse(link.url) &&
      new URL(link.url).origin === canonical.url.origin,
  );
}

export function resolveThreadIssueReference(
  reference: string,
  project: Pick<OrchestrationProjectShell, "repositoryIdentity">,
  instances: readonly GiteaInstanceConfig[],
): ResolvedIssueTarget {
  if (URL.canParse(reference)) {
    const url = new URL(reference);
    if (url.username || url.password || url.search || url.hash) {
      throw fail("Expected a canonical Gitea issue URL without credentials, query, or fragment.");
    }
    const parsed = parseIssuePath(url.pathname);
    const projectIssue = projectTarget(project, instances);
    const projectHost = project.repositoryIdentity?.canonicalKey.split("/")[0]?.toLowerCase();
    const instance =
      instanceForUrl(instances, url) ??
      (projectIssue && projectHost === url.hostname.toLowerCase() ? projectIssue.instance : null);
    if (!instance || !parsed) {
      throw fail("Only issue URLs from a configured Gitea host can be linked.");
    }
    return {
      instance,
      host: new URL(instance.webOrigin).host.toLowerCase(),
      repository: parsed.repository.toLowerCase(),
      number: parsed.number,
      url: `${url.origin}/${parsed.repository}/issues/${parsed.number}`,
    };
  }

  const match = /^([^/#\s]+)\/([^/#\s]+)#([1-9]\d*)$/.exec(reference.trim());
  if (!match) throw fail("Expected owner/repo#N or a configured Gitea issue URL.");
  const target = projectTarget(project, instances);
  if (!target) {
    throw fail("A short issue reference requires the thread project to use configured Gitea.");
  }
  const repository = `${match[1]}/${match[2]}`.toLowerCase();
  const number = Number(match[3]);
  return {
    instance: target.instance,
    host: new URL(target.instance.webOrigin).host.toLowerCase(),
    repository,
    number,
    url: `${target.instance.webOrigin.replace(/\/$/, "")}/${repository}/issues/${number}`,
  };
}

export interface ThreadIssueService {
  readonly link: (input: {
    threadId: ThreadId;
    reference: string;
  }) => Effect.Effect<{ link: ThreadIssueLink; changed: boolean }, ThreadIssueOperationError>;
  readonly unlink: (input: {
    threadId: ThreadId;
    reference: string;
  }) => Effect.Effect<{ unlinked: boolean; issue: ThreadIssueKey }, ThreadIssueOperationError>;
  readonly sync: (input: {
    threadId: ThreadId;
    issue: ThreadIssueKey & {
      readonly url: string;
      readonly snapshot: ThreadIssueSnapshot;
    };
  }) => Effect.Effect<{ synced: boolean }, ThreadIssueOperationError>;
}

export const make = Effect.gen(function* () {
  const engine = yield* ThreadManagement.ThreadManagementService;
  const projects = yield* ProjectService.ProjectService;
  const settings = yield* ServerSettingsService;
  const api = yield* GiteaApi.make;
  const crypto = yield* Crypto.Crypto;

  const context = Effect.fn("ThreadIssueService.context")(function* (threadId: ThreadId) {
    const thread = yield* engine
      .getThreadShell(threadId)
      .pipe(Effect.mapError(() => fail(`Could not read thread '${threadId}'.`)));
    if (thread === null) return yield* fail(`Thread '${threadId}' was not found.`);
    const project = yield* projects
      .getShell(thread.projectId)
      .pipe(Effect.mapError(() => fail("Could not read the thread project.")));
    if (Option.isNone(project)) return yield* fail("The thread project was not found.");
    const config = yield* settings.getSettings.pipe(
      Effect.mapError(() => fail("Could not read configured Gitea connections.")),
    );
    return { thread, project: project.value, instances: config.giteaInstances };
  });

  const commandId = Effect.fn("ThreadIssueService.commandId")(function* (tag: string) {
    const id = yield* crypto.randomUUIDv4.pipe(Effect.orDie);
    return CommandId.make(`server:${tag}:${id}`);
  });

  const sync: ThreadIssueService["sync"] = (input) =>
    Effect.gen(function* () {
      const state = yield* context(input.threadId);
      const existing = state.thread.issues?.find((issue) =>
        threadIssueKeysEqual(issue, input.issue),
      );
      if (!existing) return { synced: false };
      if (
        existing.url === input.issue.url &&
        existing.snapshot.title === input.issue.snapshot.title &&
        existing.snapshot.state === input.issue.snapshot.state
      ) {
        return { synced: false };
      }
      yield* engine
        .dispatch({
          type: "thread.issue.sync",
          commandId: yield* commandId("issue-sync"),
          threadId: input.threadId,
          ...input.issue,
        })
        .pipe(Effect.mapError((error) => fail(error.message)));
      return { synced: true };
    });

  const refresh = (threadId: ThreadId, target: ResolvedIssueTarget) =>
    Effect.gen(function* () {
      const issue = yield* fetchThreadIssueMetadata(api, target);
      if (isPullRequestIssue(issue)) {
        return yield* fail("That Gitea URL is a pull request, not an issue.");
      }
      const syncedAt = DateTime.formatIso(yield* DateTime.now);
      yield* sync({
        threadId,
        issue: {
          host: target.host,
          repository: target.repository,
          number: target.number,
          url: target.url,
          snapshot: { title: issue.title, state: issue.state, syncedAt },
        },
      });
    });

  const resolveTarget = (reference: string, state: Effect.Success<ReturnType<typeof context>>) =>
    Effect.try({
      try: () => resolveThreadIssueReference(reference, state.project, state.instances),
      catch: (error) =>
        isThreadIssueOperationError(error) ? error : fail("Invalid Gitea issue reference."),
    }).pipe(
      Effect.catch((error) =>
        Effect.gen(function* () {
          const confirmed = yield* Effect.forEach(
            aliasIssueCandidates(reference, state.instances),
            (candidate) =>
              fetchThreadIssueMetadata(api, candidate).pipe(
                Effect.timeoutOption("2 seconds"),
                Effect.map((issue) =>
                  Option.isSome(issue) && !isPullRequestIssue(issue.value)
                    ? Option.some(candidate)
                    : Option.none(),
                ),
                Effect.orElseSucceed(() => Option.none<ResolvedIssueTarget>()),
              ),
            { concurrency: "unbounded" },
          );
          const matches = confirmed.filter(Option.isSome);
          return matches.length === 1 ? matches[0]!.value : yield* error;
        }),
      ),
    );

  const link: ThreadIssueService["link"] = (input) =>
    Effect.gen(function* () {
      const state = yield* context(input.threadId);
      const target = yield* resolveTarget(input.reference, state);
      const existing = state.thread.issues?.find((issue) => threadIssueKeysEqual(issue, target));
      if (existing) {
        yield* refresh(input.threadId, target).pipe(Effect.ignore, Effect.forkDetach);
        return { link: existing, changed: false };
      }
      const fetchedIssue = yield* fetchThreadIssueMetadata(api, target).pipe(
        Effect.timeoutOption("1 second"),
        Effect.orElseSucceed(() => Option.none()),
      );
      if (Option.isSome(fetchedIssue) && isPullRequestIssue(fetchedIssue.value)) {
        return yield* fail("That Gitea URL is a pull request, not an issue.");
      }
      const now = DateTime.formatIso(yield* DateTime.now);
      const link = buildThreadIssueLink(target, Option.getOrNull(fetchedIssue), now);
      yield* engine
        .dispatch({
          type: "thread.issue.link",
          commandId: yield* commandId("issue-link"),
          threadId: input.threadId,
          link,
        })
        .pipe(Effect.mapError((error) => fail(error.message)));
      if (Option.isNone(fetchedIssue)) {
        yield* refresh(input.threadId, target).pipe(Effect.ignore, Effect.forkDetach);
      }
      return { link, changed: true };
    });

  const unlink: ThreadIssueService["unlink"] = (input) =>
    Effect.gen(function* () {
      const state = yield* context(input.threadId);
      const resolved = yield* Effect.result(
        Effect.try({
          try: () => resolveThreadIssueReference(input.reference, state.project, state.instances),
          catch: (error) =>
            isThreadIssueOperationError(error) ? error : fail("Invalid Gitea issue reference."),
        }),
      );
      const aliased =
        resolved._tag === "Failure"
          ? linkedIssueForUrl(input.reference, state.thread.issues)
          : undefined;
      if (resolved._tag === "Failure" && !aliased) return yield* resolved.failure;
      const target = resolved._tag === "Success" ? resolved.success : aliased!;
      const existing = state.thread.issues?.find((issue) => threadIssueKeysEqual(issue, target));
      const issue = { host: target.host, repository: target.repository, number: target.number };
      if (!existing) return { unlinked: false, issue };
      yield* engine
        .dispatch({
          type: "thread.issue.unlink",
          commandId: yield* commandId("issue-unlink"),
          threadId: input.threadId,
          ...issue,
        })
        .pipe(Effect.mapError((error) => fail(error.message)));
      return { unlinked: true, issue };
    });

  return { link, unlink, sync } satisfies ThreadIssueService;
});
