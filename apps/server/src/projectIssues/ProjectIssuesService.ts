import * as ShellSnapshotDiagnostics from "../diagnostics/ShellSnapshotDiagnostics.ts";
import {
  type OrchestrationV2ThreadShell,
  type ThreadSubprojectMode,
  ProjectIssuesError,
  type GiteaInstanceConfig,
  type ProjectIssue,
  type ProjectIssueDecision,
  type ProjectIssueRepository,
  type ProjectIssuesGetInput,
  type ProjectIssuesGetResult,
  type ProjectIssuesListInput,
  type ProjectIssuesListResult,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Layer from "effect/Layer";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { listMetadata } from "../forkThreads/MetadataStore.ts";
import * as ThreadIssueService from "../forkThreads/ThreadIssueService.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import * as GiteaApi from "../sourceControl/GiteaApi.ts";
import * as ProjectDashboardStore from "../projectDashboard/ProjectDashboardStore.ts";
import { makeTrackerNoteStore, type StoredRepositoryNotes } from "../dashboard/DashboardStore.ts";
import { singleFlight } from "../dashboard/DashboardRefresh.ts";
import { resolveTrackerSetting } from "../projectDashboard/projectDashboard.logic.ts";
import { parseRankTrailer, parsePlacedByTrailer } from "./requestOrder.logic.ts";
import {
  epicProgress,
  briefingEpicProgress,
  parseBriefingPartOf,
  trackerMembership,
  parseEpicChecklist,
  parsePartOf,
} from "./epicProgress.logic.ts";
import {
  collectThreadTree,
  resolveProjectTracker,
  deriveProjectIssueStatus,
  deriveRequestStage,
  giteaRepositoryForIdentity,
  instanceHost,
  isPartOf,
  parseBlockedBy,
  parseRequestMarker,
  REQUEST_LABEL,
  repositoryKey,
  workspaceRepositoryName,
  type GiteaRepositoryTarget,
} from "./projectIssues.logic.ts";
import {
  trackerPlan,
  latestProgressNote,
  trackerDueDate,
  trackerBodyTruncated,
  trackerCommentIssueNumber,
  type TrackerComment,
} from "./trackerPlan.logic.ts";
import { NEEDS_BRAD_LABEL, parseDecisionIssue } from "./decisions.logic.ts";
import { parseDecisionDeadline, parseDeferral } from "./decisionFeed.logic.ts";

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
  milestone: Schema.optional(
    Schema.NullOr(Schema.Struct({ id: Schema.Number, title: Schema.String })),
  ),
  due_date: Schema.optional(Schema.NullOr(Schema.String)),
  pull_request: Schema.optional(Schema.Unknown),
});
type GiteaIssue = typeof GiteaIssue.Type;
const GiteaIssues = Schema.Array(GiteaIssue);
const GiteaComments = Schema.Array(
  Schema.Struct({
    body: Schema.String,
    created_at: Schema.String,
    updated_at: Schema.optionalKey(Schema.String),
    user: Schema.optional(Schema.NullOr(Schema.Struct({ login: Schema.String }))),
  }),
);
const RepositoryComments = Schema.Array(
  Schema.Struct({
    id: Schema.Number,
    body: Schema.String,
    created_at: Schema.String,
    updated_at: Schema.optionalKey(Schema.String),
    issue_url: Schema.String,
  }),
);
const NOTE_BACKFILL_MAX_PAGES = 40;
const NOTE_INCREMENTAL_MAX_PAGES = 4;
interface RepositoryNotes {
  readonly notes: ReadonlyMap<number, ReturnType<typeof latestProgressNote>>;
  readonly coverage: "complete" | "bounded" | "unavailable";
  readonly error: string | null;
  readonly state?: StoredRepositoryNotes;
}
const GiteaUser = Schema.Struct({ login: Schema.String });
const GiteaRepo = Schema.Struct({ full_name: Schema.String });

const OPEN_PAGE_LIMIT = 50;
const OPEN_MAX_PAGES = 100;
const CLOSED_WINDOW_DAYS = 14;
const COMMENT_LIMIT = 10;
const COMMENT_CHARS = 4_000;
const ISSUE_CACHE_TTL_MS = 30_000;
const REPO_LOOKUP_TTL_MS = 10 * 60_000;

const fail = (message: string) => new ProjectIssuesError({ message });
const isProjectIssuesError = Schema.is(ProjectIssuesError);

export interface ProjectRepositories {
  readonly primaryRepository?: { readonly host: string; readonly repository: string } | null;
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
  const dashboardStore = yield* ProjectDashboardStore.make;

  const issueCache = new Map<string, { at: number; issues: ReadonlyArray<GiteaIssue> }>();
  const noteCache = new Map<string, { at: number; value: RepositoryNotes }>();
  const noteStore = yield* makeTrackerNoteStore;
  for (const [key, state] of Object.entries(yield* noteStore.read)) {
    noteCache.set(key, {
      at: Number.NEGATIVE_INFINITY,
      value: {
        notes: new Map(
          Object.entries(state.notes).map(([number, note]) => [
            Number(number),
            latestProgressNote([note]),
          ]),
        ),
        coverage: state.page === 1 ? "complete" : "bounded",
        error: null,
        state,
      },
    });
  }
  const ownerCache = new Map<string, { at: number; login: string | null }>();
  const repoCache = new Map<string, { at: number; exists: boolean }>();

  // Lookups cache answers, never outages: a transient failure fails the lookup so
  // callers (the request ledger's retries, the next board refresh) try again.
  const unreachable = fail("Gitea is unreachable.");
  const isAnswer = (status: number | undefined) => status !== undefined && status < 500;

  const tokenOwner = (instance: GiteaInstanceConfig) =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const cached = ownerCache.get(instance.id);
      if (cached && now - cached.at < REPO_LOOKUP_TTL_MS) return cached.login;
      if (!instance.token) return null;
      const login = yield* api.request(instance, "/user", GiteaUser).pipe(
        Effect.map((user): string | null => user.login.toLowerCase()),
        Effect.catch((error) =>
          isAnswer(error.status) ? Effect.succeed(null) : Effect.fail(unreachable),
        ),
      );
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
          Effect.catch((error) =>
            isAnswer(error.status) ? Effect.succeed(false) : Effect.fail(unreachable),
          ),
        );
      repoCache.set(key, { at: now, exists });
      return exists;
    });

  /**
   * The tracker repository for one T3 project, or null when it has none on Gitea.
   * Fails with "Gitea is unreachable." when the answer is unknown.
   */
  const repositoryForProject = (
    project: {
      readonly id: string;
      readonly workspaceRoot: string;
      readonly repositoryIdentity?: Parameters<typeof giteaRepositoryForIdentity>[0];
    },
    instances: ReadonlyArray<GiteaInstanceConfig>,
    trackerOverride?: string | null,
  ) =>
    Effect.gen(function* () {
      // An explicit tracker wins: code can live elsewhere (GitHub) while issues live on Gitea.
      const configured = trackerOverride ?? (yield* dashboardStore.read).trackers[project.id];
      const explicit = configured ? resolveTrackerSetting(configured, instances) : null;
      if (explicit) {
        return {
          instance: explicit.instance,
          host: instanceHost(explicit.instance),
          repository: explicit.repository,
        };
      }
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

  const trackerForRoot = (
    threads: Parameters<typeof resolveProjectTracker>[1],
    rootThreadId: ThreadId,
  ) =>
    dashboardStore.read.pipe(
      Effect.map((file) => resolveProjectTracker(file.trackers, threads, rootThreadId)),
    );

  const instancesOrFail = settings.getSettings.pipe(
    Effect.map((config) => config.giteaInstances),
    Effect.mapError(() => fail("Could not read configured Gitea connections.")),
  );

  /** Tree membership and repositories for an orchestrator thread's project. */
  const resolveProject = (
    rootThreadId: ThreadId,
    resolvedThreads?: ReadonlyArray<
      Pick<OrchestrationV2ThreadShell, "id" | "projectId" | "issues"> & {
        readonly parentThreadId?: ThreadId | null;
        readonly subproject?: ThreadSubprojectMode | null;
      }
    >,
  ) =>
    Effect.gen(function* () {
      const instances = yield* instancesOrFail;
      const threads =
        resolvedThreads ??
        (yield* Effect.gen(function* () {
          const snapshot = yield* engine
            .getShellSnapshot()
            .pipe(ShellSnapshotDiagnostics.withCaller("ProjectIssuesService"))
            .pipe(Effect.mapError(() => fail("Could not read threads.")));
          const parents = new Map(
            (yield* listMetadata(sql).pipe(
              Effect.mapError(() => fail("Could not read thread parents.")),
            )).map((row) => [row.threadId, row]),
          );
          const threads = [...snapshot.threads, ...snapshot.archivedThreads].map((thread) => ({
            ...thread,
            parentThreadId: parents.get(thread.id)?.parentThreadId ?? null,
            subproject: parents.get(thread.id)?.subproject ?? "auto",
          }));
          return threads;
        }));
      const tree = collectThreadTree(threads, rootThreadId);
      if (tree.length === 0) return yield* fail(`Thread '${rootThreadId}' was not found.`);
      const projectIds = new Set(tree.map((thread) => thread.projectId));
      const rootProjectId = tree[0]!.projectId;
      const projects = (yield* projectService
        .listShells({ projectIds: [...projectIds] })
        .pipe(Effect.mapError(() => fail("Could not read projects.")))).toSorted(
        (a, b) => Number(b.id === rootProjectId) - Number(a.id === rootProjectId),
      );
      const rootTracker = yield* trackerForRoot(threads, rootThreadId);
      const targets = new Map<string, GiteaRepositoryTarget>();
      let primaryRepository: { host: string; repository: string } | null = null;
      for (const project of projects) {
        const target = yield* repositoryForProject(
          project,
          instances,
          project.id === rootProjectId ? rootTracker : null,
        ).pipe(Effect.orElseSucceed(() => null));
        if (target) {
          targets.set(repositoryKey(target), target);
          if (project.id === rootProjectId)
            primaryRepository = { host: target.host, repository: target.repository };
        }
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
        primaryRepository,
        treeThreadIds: new Set(tree.map((thread) => thread.id)),
        targets: [...targets.values()],
        linkedThreads,
      } satisfies ProjectRepositories;
    });

  const fetchRepositoryIssues = (
    target: GiteaRepositoryTarget,
    complete = false,
    closedHistory = false,
  ) =>
    Effect.gen(function* () {
      const key = repositoryKey(target);
      const now = yield* Clock.currentTimeMillis;
      const cached = issueCache.get(key);
      if (!complete && cached && now - cached.at < ISSUE_CACHE_TTL_MS) return cached.issues;
      const base = `${GiteaApi.repositoryPath(target.repository)}/issues?type=issues`;
      const issues: GiteaIssue[] = [];
      for (let page = 1; page <= (complete ? 100 : OPEN_MAX_PAGES); page++) {
        const batch = yield* api.request(
          target.instance,
          `${base}&state=open&limit=${OPEN_PAGE_LIMIT}&page=${page}`,
          GiteaIssues,
        );
        issues.push(...batch);
        if (batch.length < OPEN_PAGE_LIMIT) break;
        if (page === 100) return yield* fail("The tracker is too large to order safely.");
      }
      const since = DateTime.formatIso(DateTime.makeUnsafe(now - CLOSED_WINDOW_DAYS * 86_400_000));
      if (closedHistory) {
        for (let page = 1; page <= 100; page++) {
          const batch = yield* api.request(
            target.instance,
            `${base}&state=closed&limit=${OPEN_PAGE_LIMIT}&page=${page}`,
            GiteaIssues,
          );
          issues.push(...batch);
          if (batch.length < OPEN_PAGE_LIMIT) break;
          if (page === 100)
            return yield* fail("The tracker history is too large to verify filing safely.");
        }
      } else
        issues.push(
          ...(yield* api.request(
            target.instance,
            `${base}&state=closed&limit=${OPEN_PAGE_LIMIT}&since=${encodeURIComponent(since)}`,
            GiteaIssues,
          )),
        );
      const withoutPullRequests = issues.filter((issue) => issue.pull_request == null);
      if (!complete) issueCache.set(key, { at: now, issues: withoutPullRequests });
      return withoutPullRequests;
    });

  const readRepositoryNotes = Effect.fnUntraced(function* (target: GiteaRepositoryTarget) {
    const key = repositoryKey(target);
    const now = yield* Clock.currentTimeMillis;
    const cached = noteCache.get(key);
    if (cached && now - cached.at < ISSUE_CACHE_TTL_MS) return cached.value;
    const read = Effect.gen(function* () {
      const state = cached?.value.state ?? {
        cursor: null,
        maxUpdatedAt: null,
        page: 1,
        notes: {},
        pending: {},
        scanStartedAt: null,
      };
      const scanStartedAt = state.scanStartedAt ?? DateTime.formatIso(DateTime.makeUnsafe(now));
      const pending: Record<string, TrackerComment> = { ...state.notes, ...state.pending };
      let maxUpdatedAt = state.maxUpdatedAt;
      let complete = false;
      let page = state.page;
      const budget = state.cursor === null ? NOTE_BACKFILL_MAX_PAGES : NOTE_INCREMENTAL_MAX_PAGES;
      const since =
        state.cursor === null
          ? ""
          : `&since=${encodeURIComponent(DateTime.formatIso(DateTime.makeUnsafe(Date.parse(state.cursor) - 3000)))}`;
      for (let read = 0; read < budget; read++, page++) {
        const batch = yield* api.request(
          target.instance,
          `${GiteaApi.repositoryPath(target.repository)}/issues/comments?limit=50&page=${page}${since}`,
          RepositoryComments,
        );
        for (const comment of batch) {
          const updatedAt = comment.updated_at ?? comment.created_at;
          if (
            Number.isFinite(Date.parse(updatedAt)) &&
            (!maxUpdatedAt || Date.parse(updatedAt) > Date.parse(maxUpdatedAt))
          )
            maxUpdatedAt = updatedAt;
          const number = trackerCommentIssueNumber(comment.issue_url);
          if (number === null || !comment.body.startsWith("Progress: ")) continue;
          const note = {
            id: comment.id,
            body: comment.body.slice(0, COMMENT_CHARS),
            createdAt: comment.created_at,
          };
          const previous = pending[number];
          pending[number] =
            latestProgressNote(previous && previous.id !== note.id ? [previous, note] : [note]) ??
            note;
        }
        if (batch.length < 50) {
          complete = true;
          break;
        }
      }
      const nextState: StoredRepositoryNotes = {
        // An edit to an earlier page during this scan must remain inside the next since range.
        cursor: complete
          ? DateTime.formatIso(
              DateTime.makeUnsafe(
                Math.min(Date.parse(maxUpdatedAt ?? scanStartedAt), Date.parse(scanStartedAt)),
              ),
            )
          : state.cursor,
        scanStartedAt: complete ? null : scanStartedAt,
        maxUpdatedAt,
        page: complete ? 1 : page,
        notes: complete ? pending : state.notes,
        pending: complete ? {} : pending,
      };
      yield* noteStore.write(key, nextState);
      return {
        // Partial ranges retain the last complete evidence while persisting backfill continuation.
        notes: new Map(
          Object.entries(nextState.notes).map(([number, note]) => [
            Number(number),
            latestProgressNote([note]),
          ]),
        ),
        coverage: complete ? ("complete" as const) : ("bounded" as const),
        error: null,
        state: nextState,
      };
    });
    const value: RepositoryNotes = yield* read.pipe(
      Effect.catch(() =>
        Effect.succeed({
          notes: cached?.value.notes ?? new Map(),
          coverage: "unavailable" as const,
          error: "Could not read tracker progress notes.",
          ...(cached?.value.state ? { state: cached.value.state } : {}),
        }),
      ),
    );
    noteCache.set(key, { at: now, value });
    return value;
  });
  const noteFlights = new Map<
    string,
    { target: GiteaRepositoryTarget; read: Effect.Effect<RepositoryNotes> }
  >();
  const fetchRepositoryNotes = (target: GiteaRepositoryTarget) => {
    const key = repositoryKey(target);
    let flight = noteFlights.get(key);
    if (!flight) {
      const latest = { target };
      const read = singleFlight(Effect.suspend(() => readRepositoryNotes(latest.target)));
      flight = Object.assign(latest, { read });
      noteFlights.set(key, flight);
    }
    flight.target = target;
    return flight.read;
  };

  /** Drop cached issue lists so a write shows on the next read. */
  const invalidate = (target: { host: string; repository: string }) => {
    issueCache.delete(repositoryKey(target));
    const notes = noteCache.get(repositoryKey(target));
    if (notes) noteCache.set(repositoryKey(target), { ...notes, at: Number.NEGATIVE_INFINITY });
  };

  /** The decision with the deadline its context names, when it names one. */
  const withDeadline = (
    decision: ProjectIssueDecision,
    createdAt: string,
  ): ProjectIssueDecision => {
    const deadline = parseDecisionDeadline(decision.context, createdAt);
    return deadline === null ? decision : { ...decision, deadline };
  };

  const toProjectIssue = (
    target: GiteaRepositoryTarget,
    issue: GiteaIssue,
    linkedThreadIds: ThreadId[],
    plan?: ProjectIssue["plan"],
  ): ProjectIssue => {
    const labels = (issue.labels ?? []).map((label) => label.name);
    const isRequest = labels.some(
      (label) => label.toLowerCase() === REQUEST_LABEL || label.toLowerCase().startsWith("ask:"),
    );
    const blockedBy = parseBlockedBy(issue.body);
    const parent = parsePartOf(issue.body);
    const asksBrad =
      issue.state === "open" && labels.some((label) => label.toLowerCase() === NEEDS_BRAD_LABEL);
    const deferral = issue.state === "open" ? parseDeferral(issue.body) : null;
    return {
      host: target.host,
      repository: target.repository,
      number: issue.number,
      title: issue.title.trim() || `#${issue.number}`,
      url: issue.html_url,
      status: deriveProjectIssueStatus(issue.state, labels),
      labels,
      isRequest,
      dueDate: trackerDueDate(issue.due_date),
      plan:
        plan ??
        trackerPlan({
          body: issue.body,
          closed: issue.state === "closed",
          closedAt: issue.closed_at ?? null,
          stage: deriveRequestStage(issue.state, labels),
        }),
      rank: parseRankTrailer(issue.body),
      placedBy: parsePlacedByTrailer(issue.body),
      ...(parent !== null && parent !== issue.number ? { partOf: parent } : {}),
      ...(isRequest ? { stage: deriveRequestStage(issue.state, labels) } : {}),
      ...(blockedBy.length > 0 ? { blockedBy } : {}),
      ...(asksBrad
        ? { decision: withDeadline(parseDecisionIssue(issue.body), issue.created_at) }
        : {}),
      ...(deferral ? { deferral } : {}),
      milestone:
        issue.milestone && issue.milestone.id > 0 && issue.milestone.title.trim()
          ? { id: issue.milestone.id, title: issue.milestone.title.trim() }
          : null,
      requestSource: parseRequestMarker(issue.body),
      assignees: (issue.assignees ?? []).map((assignee) => assignee.login),
      comments: Math.max(0, issue.comments ?? 0),
      createdAt: issue.created_at,
      updatedAt: issue.updated_at,
      closedAt: issue.closed_at ?? null,
      linkedThreadIds,
    };
  };

  const list = (
    input: ProjectIssuesListInput,
    options: { complete?: boolean; closedHistory?: boolean } = {},
    resolvedThreads?: Parameters<typeof resolveProject>[1],
  ) =>
    Effect.gen(function* () {
      const project = yield* resolveProject(input.rootThreadId, resolvedThreads);
      const repositories: ProjectIssueRepository[] = [];
      const issues: ProjectIssue[] = [];
      const results = yield* Effect.forEach(
        project.targets,
        (target) =>
          fetchRepositoryIssues(target, options.complete, options.closedHistory).pipe(
            Effect.map((items) => ({ target, items, error: null as string | null })),
            Effect.catch((error) =>
              Effect.succeed({
                target,
                items: [] as GiteaIssue[],
                error: isProjectIssuesError(error) ? error.message : error.detail,
              }),
            ),
          ),
        { concurrency: 4 },
      );
      for (const { target, items, error } of results) {
        const notes: RepositoryNotes = error
          ? { notes: new Map(), coverage: "unavailable" as const, error: null }
          : yield* fetchRepositoryNotes(target);
        repositories.push({
          host: target.host,
          repository: target.repository,
          error,
          noteCoverage: notes.coverage,
          noteError: notes.error,
        });
        const sourceItems = items.map((issue) => ({
          number: issue.number,
          body: issue.body,
          labels: (issue.labels ?? []).map((label) => label.name),
          closed: issue.state === "closed",
        }));
        const membership = trackerMembership(sourceItems);
        const epics = epicProgress(sourceItems, membership);
        const briefingEpics = briefingEpicProgress(sourceItems);
        for (const issue of items) {
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
          const children = membership.workstreams.has(issue.number)
            ? (membership.children.get(issue.number) ?? [])
            : undefined;
          const plan = trackerPlan({
            body: issue.body,
            closed: issue.state === "closed",
            closedAt: issue.closed_at ?? null,
            stage: deriveRequestStage(
              issue.state,
              (issue.labels ?? []).map((label) => label.name),
            ),
            note: notes.notes.get(issue.number),
            children,
          });
          const projected = toProjectIssue(
            target,
            issue,
            project.linkedThreads.get(issueKey) ?? [],
            plan,
          );
          const { partOf: _partOf, ...base } = projected;
          issues.push({
            ...base,
            briefingPartOf: parseBriefingPartOf(issue.body),
            ...(briefingEpics.has(issue.number)
              ? { briefingEpic: briefingEpics.get(issue.number)! }
              : {}),
            ...(membership.parents.has(issue.number)
              ? { partOf: membership.parents.get(issue.number)! }
              : membership.warnings.get(issue.number)?.includes("missing-or-closed-parent") &&
                  _partOf
                ? { partOf: _partOf }
                : {}),
            ...(membership.warnings.has(issue.number) || trackerBodyTruncated(issue.body)
              ? {
                  membershipWarnings: [
                    ...(membership.warnings.get(issue.number) ?? []),
                    ...(trackerBodyTruncated(issue.body) ? ["truncated-body"] : []),
                  ],
                }
              : {}),
            plan,
            ...(epics.has(issue.number)
              ? {
                  epic: {
                    ...epics.get(issue.number)!,
                    children: children?.map((c) => c.number) ?? [],
                    unknown: children?.filter((c) => c.unknown).map((c) => c.number) ?? [],
                  },
                }
              : {}),
          });
        }
      }
      return {
        primaryRepository: project.primaryRepository ?? null,
        repositories,
        issues: issues.toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
        fetchedAt: DateTime.formatIso(yield* DateTime.now),
      } satisfies ProjectIssuesListResult;
    });

  /** One issue of the project with its body, latest comments and the issues "Part of" it. */
  const get = (input: ProjectIssuesGetInput) =>
    Effect.gen(function* () {
      const project = yield* resolveProject(input.rootThreadId);
      const target = project.targets.find(
        (candidate) => repositoryKey(candidate) === repositoryKey(input),
      );
      if (!target) return yield* fail("That repository is not part of this project.");
      const path = `${GiteaApi.repositoryPath(target.repository)}/issues/${input.number}`;
      const [raw, comments, siblings] = yield* Effect.all(
        [
          api.request(target.instance, path, GiteaIssue),
          api.request(target.instance, `${path}/comments`, GiteaComments),
          fetchRepositoryIssues(target),
        ],
        { concurrency: 3 },
      ).pipe(
        Effect.mapError((error) =>
          fail(isProjectIssuesError(error) ? error.message : error.detail),
        ),
      );
      if (raw.pull_request != null) return yield* fail("That is a pull request, not an issue.");
      const issueKey = `${repositoryKey(target)}#${raw.number}`;
      return {
        issue: toProjectIssue(target, raw, project.linkedThreads.get(issueKey) ?? []),
        body: raw.body ?? "",
        comments: comments.slice(-COMMENT_LIMIT).map((comment) => ({
          author: comment.user?.login ?? "",
          body: comment.body.slice(0, COMMENT_CHARS),
          createdAt: comment.created_at,
        })),
        // The same children epic progress counts: the body checklist plus "Part of #N".
        childNumbers: [
          ...new Set([
            ...parseEpicChecklist(raw.body).map((item) => item.number),
            ...siblings
              .filter((sibling) => isPartOf(sibling.body, raw.number))
              .map((sibling) => sibling.number),
          ]),
        ].filter((number) => number !== raw.number),
      } satisfies ProjectIssuesGetResult;
    });

  return {
    list,
    get,
    resolveProject,
    repositoryForProject,
    trackerForRoot,
    invalidate,
    instancesOrFail,
  };
});

export type ProjectIssuesService = Effect.Success<typeof make>;

export class Service extends Context.Service<Service, ProjectIssuesService>()(
  "t3/projectIssues/ProjectIssuesService/Service",
) {}
export const layer = Layer.effect(Service, make);
