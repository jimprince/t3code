import {
  ProjectIssuesError,
  type GiteaInstanceConfig,
  type ProjectIssue,
  type ProjectIssueRepository,
  type ProjectIssuesListInput,
  type ProjectIssuesListResult,
  type ThreadId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { listMetadata } from "../forkThreads/MetadataStore.ts";
import * as ThreadIssueService from "../forkThreads/ThreadIssueService.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import * as GiteaApi from "../sourceControl/GiteaApi.ts";
import {
  collectThreadTree,
  deriveProjectIssueStatus,
  giteaRepositoryForIdentity,
  instanceHost,
  parseRequestMarker,
  REQUEST_LABEL,
  repositoryKey,
  workspaceRepositoryName,
  type GiteaRepositoryTarget,
} from "./projectIssues.logic.ts";

const GiteaLabel = Schema.Struct({ name: Schema.String });
const GiteaIssue = Schema.Struct({
  number: Schema.Number,
  title: Schema.String,
  body: Schema.optional(Schema.NullOr(Schema.String)),
  state: Schema.Literals(["open", "closed"]),
  html_url: Schema.String,
  labels: Schema.optional(Schema.NullOr(Schema.Array(GiteaLabel))),
  assignees: Schema.optional(Schema.NullOr(Schema.Array(Schema.Struct({ login: Schema.String })))),
  comments: Schema.optional(Schema.Number),
  created_at: Schema.String,
  updated_at: Schema.String,
  closed_at: Schema.optional(Schema.NullOr(Schema.String)),
  pull_request: Schema.optional(Schema.Unknown),
});
type GiteaIssue = typeof GiteaIssue.Type;
const GiteaIssues = Schema.Array(GiteaIssue);
const GiteaUser = Schema.Struct({ login: Schema.String });
const GiteaRepo = Schema.Struct({ full_name: Schema.String });

const OPEN_PAGE_LIMIT = 50;
const OPEN_MAX_PAGES = 4;
const CLOSED_WINDOW_DAYS = 14;
const ISSUE_CACHE_TTL_MS = 30_000;
const REPO_LOOKUP_TTL_MS = 10 * 60_000;

const fail = (message: string) => new ProjectIssuesError({ message });

export interface ProjectRepositories {
  readonly treeThreadIds: ReadonlySet<ThreadId>;
  readonly targets: ReadonlyArray<GiteaRepositoryTarget>;
  /** Issue keys linked to each tree thread, for linkedThreadIds. */
  readonly linkedThreads: ReadonlyMap<string, ThreadId[]>;
}

/**
 * Reads a project's Gitea issues for the project page board and the request ledger.
 * A project is an orchestrator thread's tree; its repositories are every tree
 * thread's project repository on a configured Gitea host (or the same-named
 * tracker repository under the token's account, the Agent Status Board's rule),
 * plus every repository a tree thread links an issue from.
 */
export const make = Effect.gen(function* () {
  const engine = yield* ThreadManagement.ThreadManagementService;
  const projectService = yield* ProjectService.ProjectService;
  const sql = yield* SqlClient.SqlClient;
  const settings = yield* ServerSettingsService;
  const api = yield* GiteaApi.make;
  const threadIssues = yield* ThreadIssueService.make;

  const issueCache = new Map<string, { at: number; issues: ReadonlyArray<GiteaIssue> }>();
  const ownerCache = new Map<string, { at: number; login: string | null }>();
  const repoCache = new Map<string, { at: number; exists: boolean }>();

  const tokenOwner = (instance: GiteaInstanceConfig) =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const cached = ownerCache.get(instance.id);
      if (cached && now - cached.at < REPO_LOOKUP_TTL_MS) return cached.login;
      const login = instance.token
        ? yield* api.request(instance, "/user", GiteaUser).pipe(
            Effect.map((user) => user.login.toLowerCase()),
            Effect.orElseSucceed(() => null),
          )
        : null;
      ownerCache.set(instance.id, { at: now, login });
      return login;
    });

  const repositoryExists = (instance: GiteaInstanceConfig, repository: string) =>
    Effect.gen(function* () {
      const key = `${instance.id}:${repository}`;
      const now = yield* Clock.currentTimeMillis;
      const cached = repoCache.get(key);
      if (cached && now - cached.at < REPO_LOOKUP_TTL_MS) return cached.exists;
      const exists = yield* api
        .request(instance, GiteaApi.repositoryPath(repository), GiteaRepo)
        .pipe(
          Effect.as(true),
          Effect.orElseSucceed(() => false),
        );
      repoCache.set(key, { at: now, exists });
      return exists;
    });

  /** The tracker repository for one T3 project, or null when it has none on Gitea. */
  const repositoryForProject = (
    project: {
      readonly workspaceRoot: string;
      readonly repositoryIdentity?: Parameters<typeof giteaRepositoryForIdentity>[0];
    },
    instances: ReadonlyArray<GiteaInstanceConfig>,
  ) =>
    Effect.gen(function* () {
      const direct = giteaRepositoryForIdentity(project.repositoryIdentity, instances);
      if (direct) return direct;
      const name = workspaceRepositoryName(project.workspaceRoot);
      if (!name) return null;
      for (const instance of instances) {
        const owner = yield* tokenOwner(instance);
        if (!owner) continue;
        const repository = `${owner}/${name}`;
        if (yield* repositoryExists(instance, repository)) {
          return { instance, host: instanceHost(instance), repository };
        }
      }
      return null;
    });

  const instancesOrFail = settings.getSettings.pipe(
    Effect.map((config) => config.giteaInstances),
    Effect.mapError(() => fail("Could not read configured Gitea connections.")),
  );

  /** Tree membership and repositories for an orchestrator thread's project. */
  const resolveProject = (rootThreadId: ThreadId) =>
    Effect.gen(function* () {
      const instances = yield* instancesOrFail;
      const snapshot = yield* engine
        .getShellSnapshot()
        .pipe(Effect.mapError(() => fail("Could not read threads.")));
      const parents = new Map(
        (yield* listMetadata(sql).pipe(
          Effect.mapError(() => fail("Could not read thread parents.")),
        )).map((row) => [row.threadId, row.parentThreadId]),
      );
      const tree = collectThreadTree(
        [...snapshot.threads, ...snapshot.archivedThreads].map((thread) => ({
          ...thread,
          parentThreadId: parents.get(thread.id) ?? null,
        })),
        rootThreadId,
      );
      if (tree.length === 0) return yield* fail(`Thread '${rootThreadId}' was not found.`);
      const projectIds = new Set(tree.map((thread) => thread.projectId));
      const rootProjectId = tree[0]!.projectId;
      const projects = (yield* projectService
        .listShells({ projectIds: [...projectIds] })
        .pipe(Effect.mapError(() => fail("Could not read projects.")))).toSorted(
        (a, b) => Number(b.id === rootProjectId) - Number(a.id === rootProjectId),
      );
      const targets = new Map<string, GiteaRepositoryTarget>();
      for (const project of projects) {
        const target = yield* repositoryForProject(project, instances);
        if (target) targets.set(repositoryKey(target), target);
      }
      const linkedThreads = new Map<string, ThreadId[]>();
      for (const thread of tree) {
        for (const issue of thread.issues ?? []) {
          const key = `${repositoryKey(issue)}#${issue.number}`;
          linkedThreads.set(key, [...(linkedThreads.get(key) ?? []), thread.id]);
          const repoKey = repositoryKey(issue);
          if (targets.has(repoKey)) continue;
          const instance = instances.find((candidate) => instanceHost(candidate) === issue.host);
          if (instance) {
            targets.set(repoKey, { instance, host: issue.host, repository: issue.repository });
          }
        }
      }
      return {
        treeThreadIds: new Set(tree.map((thread) => thread.id)),
        targets: [...targets.values()],
        linkedThreads,
      } satisfies ProjectRepositories;
    });

  const fetchRepositoryIssues = (target: GiteaRepositoryTarget) =>
    Effect.gen(function* () {
      const key = repositoryKey(target);
      const now = yield* Clock.currentTimeMillis;
      const cached = issueCache.get(key);
      if (cached && now - cached.at < ISSUE_CACHE_TTL_MS) return cached.issues;
      const base = `${GiteaApi.repositoryPath(target.repository)}/issues?type=issues`;
      const issues: GiteaIssue[] = [];
      for (let page = 1; page <= OPEN_MAX_PAGES; page++) {
        const batch = yield* api.request(
          target.instance,
          `${base}&state=open&limit=${OPEN_PAGE_LIMIT}&page=${page}`,
          GiteaIssues,
        );
        issues.push(...batch);
        if (batch.length < OPEN_PAGE_LIMIT) break;
      }
      const since = DateTime.formatIso(DateTime.makeUnsafe(now - CLOSED_WINDOW_DAYS * 86_400_000));
      issues.push(
        ...(yield* api.request(
          target.instance,
          `${base}&state=closed&limit=${OPEN_PAGE_LIMIT}&since=${encodeURIComponent(since)}`,
          GiteaIssues,
        )),
      );
      const withoutPullRequests = issues.filter((issue) => issue.pull_request == null);
      issueCache.set(key, { at: now, issues: withoutPullRequests });
      return withoutPullRequests;
    });

  /** Drop cached issue lists so a write shows on the next read. */
  const invalidate = (target: { host: string; repository: string }) => {
    issueCache.delete(repositoryKey(target));
  };

  const list = (input: ProjectIssuesListInput) =>
    Effect.gen(function* () {
      const project = yield* resolveProject(input.rootThreadId);
      const repositories: ProjectIssueRepository[] = [];
      const issues: ProjectIssue[] = [];
      const results = yield* Effect.forEach(
        project.targets,
        (target) =>
          fetchRepositoryIssues(target).pipe(
            Effect.map((items) => ({ target, items, error: null as string | null })),
            Effect.catch((error) =>
              Effect.succeed({ target, items: [] as GiteaIssue[], error: error.detail }),
            ),
          ),
        { concurrency: 4 },
      );
      for (const { target, items, error } of results) {
        repositories.push({ host: target.host, repository: target.repository, error });
        for (const issue of items) {
          const labels = (issue.labels ?? []).map((label) => label.name);
          const issueKey = `${repositoryKey(target)}#${issue.number}`;
          // Refresh persisted badge snapshots from the board's existing API read.
          // sync checks that the link still exists, so unlink races cannot resurrect it.
          for (const threadId of project.linkedThreads.get(issueKey) ?? []) {
            const thread = yield* engine
              .getThreadShell(threadId)
              .pipe(Effect.mapError(() => fail("Could not read linked thread issues.")));
            const link =
              thread !== null
                ? thread.issues?.find(
                    (candidate) =>
                      candidate.host === target.host &&
                      candidate.repository === target.repository &&
                      candidate.number === issue.number,
                  )
                : undefined;
            if (link) {
              yield* threadIssues
                .sync({
                  threadId,
                  issue: {
                    host: target.host,
                    repository: target.repository,
                    number: issue.number,
                    url: link.url,
                    snapshot: {
                      title: issue.title,
                      state: issue.state,
                      syncedAt: DateTime.formatIso(yield* DateTime.now),
                    },
                  },
                })
                .pipe(Effect.ignore);
            }
          }
          issues.push({
            host: target.host,
            repository: target.repository,
            number: issue.number,
            title: issue.title.trim() || `#${issue.number}`,
            url: issue.html_url,
            status: deriveProjectIssueStatus(issue.state, labels),
            labels,
            isRequest: labels.some((label) => label.toLowerCase() === REQUEST_LABEL),
            requestSource: parseRequestMarker(issue.body),
            assignees: (issue.assignees ?? []).map((assignee) => assignee.login),
            comments: Math.max(0, issue.comments ?? 0),
            createdAt: issue.created_at,
            updatedAt: issue.updated_at,
            closedAt: issue.closed_at ?? null,
            linkedThreadIds: project.linkedThreads.get(issueKey) ?? [],
          });
        }
      }
      return {
        repositories,
        issues: issues.toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
        fetchedAt: DateTime.formatIso(yield* DateTime.now),
      } satisfies ProjectIssuesListResult;
    });

  return { list, resolveProject, repositoryForProject, invalidate, instancesOrFail };
});

export type ProjectIssuesService = Effect.Success<typeof make>;
