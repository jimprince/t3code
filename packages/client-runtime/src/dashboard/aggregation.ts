import { ThreadId as ThreadIdSchema } from "@t3tools/contracts";
import { isThreadResumable } from "../threadResume.ts";
import type {
  DashboardAttention,
  DashboardProject,
  DashboardSnapshot,
  DashboardSource,
  DashboardTask,
  ForkThreadMetadata,
  OrchestrationV2ThreadShell,
  OrchestrationV2ShellSnapshot,
  ProjectIssue,
  ProjectPendingAsk,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
function collectThreadTree<T extends { id: ThreadId; parentThreadId: ThreadId | null }>(
  threads: readonly T[],
  root: ThreadId,
): T[] {
  const out: T[] = [];
  const seen = new Set<ThreadId>();
  const queue = threads.filter((t) => t.id === root);
  for (let i = 0; i < queue.length; i++) {
    const t = queue[i]!;
    if (seen.has(t.id)) continue;
    seen.add(t.id);
    out.push(t);
    queue.push(...threads.filter((child) => child.parentThreadId === t.id));
  }
  return out;
}
import { emptySnapshot, issueId, movement, indexSamples, type ProgressSample } from "./progress.ts";

export const BriefingPlan = Schema.Struct({
  fileName: Schema.optionalKey(Schema.String),
  rootThreadId: Schema.optionalKey(ThreadIdSchema),
  source: Schema.optionalKey(Schema.Literal("tracker")),
  head: Schema.String,
  title: Schema.String,
  updated_utc: Schema.String,
  workstreams: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      title: Schema.String,
      tasks: Schema.Array(
        Schema.Struct({
          id: Schema.String,
          title: Schema.String,
          kind: Schema.String,
          link: Schema.String,
          steps_total: Schema.Int,
          steps_done: Schema.Int,
          eta_utc: Schema.NullOr(Schema.String),
          next_step: Schema.String,
          updated_utc: Schema.String,
        }),
      ),
    }),
  ),
});
export type BriefingPlan = typeof BriefingPlan.Type;
/** Unflagged legacy heads bind on a unique exact title; new files carry rootThreadId explicitly. */
export function briefingPlanRoot(
  plan: Pick<BriefingPlan, "rootThreadId" | "head" | "title">,
  roots: readonly { id: ThreadId; title: string }[],
): ThreadId | null {
  if (plan.rootThreadId)
    return roots.some((root) => root.id === plan.rootThreadId) ? plan.rootThreadId : null;
  const matches = roots.filter(
    (root) => root.title.trim().toLowerCase() === plan.title.trim().toLowerCase(),
  );
  return matches.length === 1 ? matches[0]!.id : null;
}
const UNCONFIRMED_AT = "1970-01-01T00:00:00.000Z";
const utility = (title: string) =>
  /^(reliability|quota|quality|security|maintenance|deployment)(\b|$)/i.test(title);
type DashboardShell = Pick<
  OrchestrationV2ThreadShell,
  "id" | "title" | "archivedAt" | "todoProgress" | "updatedAt"
> &
  Partial<Pick<OrchestrationV2ThreadShell, "settledOverride" | "status" | "planResumeState">>;
/** A run is in flight: working or waiting on someone. */
const IN_FLIGHT_RUN_STATUSES: ReadonlySet<string> = new Set([
  "preparing",
  "queued",
  "starting",
  "running",
  "waiting",
]);
const isThreadInFlight = (thread: DashboardShell) =>
  thread.status !== undefined && IN_FLIGHT_RUN_STATUSES.has(thread.status);
/** Retired and explicitly settled heads no longer own dashboard work. */
export const isDashboardThreadActive = (thread: DashboardShell) =>
  thread.archivedAt === null &&
  thread.settledOverride !== "settled" &&
  !/\(retired\b/i.test(thread.title);

export function dashboardRoots(
  shells: readonly DashboardShell[],
  metadata: readonly ForkThreadMetadata[],
  remoteParentThreadIds: readonly ThreadId[] = [],
) {
  const parents = new Map(metadata.map((row) => [row.threadId, row]));
  const allThreads = shells.map((thread) => ({
    ...thread,
    parentThreadId: parents.get(thread.id)?.parentThreadId ?? null,
    subproject: parents.get(thread.id)?.subproject ?? "auto",
  }));
  const remoteParents = new Set(remoteParentThreadIds);
  const isRoot = (t: (typeof allThreads)[number]) =>
    t.subproject === "on" ||
    (!t.parentThreadId &&
      (remoteParents.has(t.id) ||
        allThreads.some(
          (child) => child.parentThreadId === t.id && isDashboardThreadActive(child),
        )));
  const excluded = new Set(allThreads.filter((t) => !isDashboardThreadActive(t)).map((t) => t.id));
  // A retired head's descendants must not leak back into its parent's Plan or Decisions.
  for (let changed = true; changed;) {
    changed = false;
    for (const thread of allThreads)
      if (
        thread.parentThreadId &&
        excluded.has(thread.parentThreadId) &&
        !excluded.has(thread.id)
      ) {
        excluded.add(thread.id);
        changed = true;
      }
  }
  const threads = allThreads.filter((t) => !excluded.has(t.id));
  return { threads, roots: threads.filter((t) => isRoot(t) && isDashboardThreadActive(t)) };
}
export function aggregate(input: {
  readonly shells: readonly DashboardShell[];
  readonly metadata: readonly ForkThreadMetadata[];
  readonly issues: ReadonlyMap<ThreadId, readonly ProjectIssue[]>;
  readonly sources: readonly DashboardSource[];
  readonly plans: readonly BriefingPlan[];
  readonly samples: readonly ProgressSample[];
  readonly now: string;
  readonly pendingAsks?: readonly ProjectPendingAsk[];
  readonly remoteParentThreadIds?: readonly ThreadId[];
  readonly previous?: DashboardSnapshot;
  readonly trackerRoots?: ReadonlySet<ThreadId>;
  readonly rootRepositories?: ReadonlyMap<ThreadId, string>;
}): DashboardSnapshot {
  const { threads, roots } = dashboardRoots(
    input.shells,
    input.metadata,
    input.remoteParentThreadIds,
  );
  const boundPlans = new Map(input.plans.map((plan) => [plan, briefingPlanRoot(plan, roots)]));
  const trackerRoots = new Set(input.trackerRoots ?? []);
  for (const root of roots) {
    const plans = input.plans.filter((plan) => boundPlans.get(plan) === root.id);
    if (plans.some((plan) => plan.source === "tracker" && plan.rootThreadId === root.id))
      trackerRoots.add(root.id);
  }
  const fallbackPlans = input.plans.filter((plan) => {
    const root = boundPlans.get(plan);
    return root ? !trackerRoots.has(root) : plan.source !== "tracker";
  });
  const projects: DashboardProject[] = [];
  const history = indexSamples(input.samples);
  const trees = new Map(roots.map((root) => [root.id, collectThreadTree(threads, root.id)]));
  // Linked work belongs to the nearest project root, then the repository's own root.
  const owners = new Map<string, ThreadId>();
  const included = new Set(threads.map((t) => t.id));
  const excluded = new Set(input.shells.filter((t) => !included.has(t.id)).map((t) => t.id));
  const rows = new Map<string, ProjectIssue>();
  for (const root of roots)
    for (const issue of input.issues.get(root.id) ?? []) {
      // Shared repositories can return a retired head's decision through another active root.
      if (
        (issue.owner && excluded.has(issue.owner.threadId)) ||
        (issue.linkedThreadIds.length > 0 && issue.linkedThreadIds.every((id) => excluded.has(id)))
      )
        continue;
      const key = issueId(issue.host, issue.repository, issue.number);
      const prior = rows.get(key);
      const selected =
        prior && Date.parse(prior.updatedAt) > Date.parse(issue.updatedAt) ? prior : issue;
      const selectedPlan = selected.plan;
      const otherPlan = selected === issue ? prior?.plan : issue.plan;
      const plan =
        selectedPlan &&
        otherPlan &&
        selectedPlan.planVersion === otherPlan.planVersion &&
        selectedPlan.evidenceVersion === otherPlan.evidenceVersion &&
        selectedPlan.done === otherPlan.done &&
        selectedPlan.total === otherPlan.total &&
        otherPlan.confirmedAt &&
        Date.parse(otherPlan.confirmedAt) > Date.parse(selectedPlan.confirmedAt ?? "1970-01-01")
          ? { ...selectedPlan, confirmedAt: otherPlan.confirmedAt }
          : selectedPlan;
      rows.set(
        key,
        prior
          ? {
              ...selected,
              ...(plan ? { plan } : {}),
              linkedThreadIds: [...new Set([...prior.linkedThreadIds, ...issue.linkedThreadIds])],
            }
          : issue,
      );
    }
  const liveThreads = threads.filter((t) => t.archivedAt === null);
  const waitingThreads = new Map(
    [...rows].flatMap(([key, issue]) => {
      const wanted = issue.decision?.waiting.trim();
      if (!wanted) return [];
      // Legacy cards can carry "agent-name (thread-prefix)". A unique saved id is stronger
      // evidence than the older server's project-head stand-in for an unresolved name.
      const prefix = wanted.match(/\(([a-f0-9]{8,})\)$/i)?.[1];
      const matches = liveThreads.filter(
        (t) => t.id === wanted || (prefix && t.id.startsWith(prefix)),
      );
      return matches.length === 1 ? [[key, matches[0]!.id] as const] : [];
    }),
  );
  for (const [key, issue] of rows) {
    const waiting = waitingThreads.get(key);
    const candidates = roots.filter(
      (root) =>
        input.issues.get(root.id)?.some((i) => issueId(i.host, i.repository, i.number) === key) ||
        trees.get(root.id)!.some((t) => t.id === waiting),
    );
    const waitingOwner = candidates
      .filter((root) => trees.get(root.id)!.some((t) => t.id === waiting))
      .sort((a, b) => trees.get(a.id)!.length - trees.get(b.id)!.length)[0];
    const linked = candidates
      .filter((root) => trees.get(root.id)!.some((t) => issue.linkedThreadIds.includes(t.id)))
      .sort(
        (a, b) => trees.get(a.id)!.length - trees.get(b.id)!.length || a.id.localeCompare(b.id),
      );
    const provenance = issue.requestSource
      ? candidates
          .filter(
            (root) =>
              root.id === issue.requestSource!.rootThreadId ||
              trees.get(root.id)!.some((thread) => thread.id === issue.requestSource!.threadId),
          )
          .sort(
            (a, b) => trees.get(a.id)!.length - trees.get(b.id)!.length || a.id.localeCompare(b.id),
          )[0]
      : undefined;
    const ownRepo = candidates
      .filter(
        (root) => input.rootRepositories?.get(root.id) === `${issue.host}/${issue.repository}`,
      )
      .sort(
        (a, b) =>
          Number(!!a.parentThreadId) - Number(!!b.parentThreadId) ||
          trees.get(b.id)!.length - trees.get(a.id)!.length ||
          a.id.localeCompare(b.id),
      )[0];
    const owner =
      waitingOwner ??
      linked[0] ??
      provenance ??
      ownRepo ??
      [...candidates].sort((a, b) => a.id.localeCompare(b.id))[0];
    if (owner) owners.set(key, owner.id);
  }
  const issueUrlOwners = new Map(
    [...rows].flatMap(([id, issue]) => {
      const owner = owners.get(id);
      return owner ? [[issue.url, owner] as const] : [];
    }),
  );
  const localOwners = new Map<ThreadId, ThreadId>();
  for (const root of [...roots].sort(
    (a, b) => trees.get(a.id)!.length - trees.get(b.id)!.length || a.id.localeCompare(b.id),
  )) {
    for (const thread of trees.get(root.id)!)
      if (!localOwners.has(thread.id)) localOwners.set(thread.id, root.id);
  }
  for (const root of roots) {
    const tree = trees.get(root.id)!;
    const issues = [...rows.entries()]
      .filter(([key]) => owners.get(key) === root.id)
      .map(([, issue]) => issue);
    const tracker = trackerRoots.has(root.id);
    const attention: DashboardAttention[] = [];
    // Threads whose steps an issue row already counts as its own progress.
    const progressSources = new Set<ThreadId>();
    const tasks: DashboardTask[] = issues
      .filter(
        (i) =>
          i.status !== "archived" &&
          i.status !== "backlog" &&
          (i.status !== "done" ||
            !i.closedAt ||
            Date.parse(input.now) - Date.parse(i.closedAt) <= 24 * 60 * 60_000),
      )
      .map((issue) => {
        const id = issueId(issue.host, issue.repository, issue.number);
        const sourceId = `gitea:${issue.host}/${issue.repository}`;
        const linked = tree.find(
          (t) => issue.linkedThreadIds.includes(t.id) && t.todoProgress && t.todoProgress.total > 0,
        );
        const labels = new Set(issue.labels.map((label) => label.toLowerCase()));
        const labelledEpic =
          labels.has("ask:epic") ||
          (labels.has("ask:plan") && !labels.has("ask:task") && !labels.has("ask:question"));
        const epic = tracker
          ? issue.epic
          : labelledEpic
            ? (issue.briefingEpic ?? issue.epic)
            : undefined;
        const parent = tracker
          ? issue.partOf
          : issue.briefingPartOf === undefined
            ? issue.partOf
            : issue.briefingPartOf;
        const progress =
          tracker && issue.plan
            ? {
                done: issue.plan.done,
                total: issue.plan.total,
                planVersion: issue.plan.planVersion,
                sourceId,
                confirmedAt: issue.plan.confirmedAt ?? UNCONFIRMED_AT,
                confirmationKnown: issue.plan.confirmedAt !== null,
              }
            : epic
              ? {
                  done: epic.done,
                  total: epic.total,
                  planVersion: `epic:${epic.total}`,
                  sourceId,
                  confirmedAt: issue.updatedAt,
                }
              : linked?.todoProgress
                ? {
                    done: linked.todoProgress.completed,
                    total: linked.todoProgress.total,
                    planVersion: `todo:${linked.id}:${linked.todoProgress.total}`,
                    sourceId: "local",
                    confirmedAt: DateTime.formatIso(linked.updatedAt),
                  }
                : null;
        if (!epic && linked?.todoProgress) progressSources.add(linked.id);
        const attentionIds: string[] = [];
        if (
          issue.status !== "done" &&
          issue.stage !== "awaiting-release" &&
          (issue.decision ||
            issue.stage === "ready" ||
            issue.stage === "needs-test" ||
            issue.labels.includes("needs-review") ||
            issue.labels.includes("needs-test")) &&
          (!issue.deferral?.until || issue.deferral.until <= input.now)
        ) {
          const attentionId = `${id}:attention`;
          attentionIds.push(attentionId);
          attention.push({
            id: attentionId,
            taskId: id,
            requestId: null,
            canRespond: true,
            options: issue.decision?.options ?? [],
            priority: issue.labels.includes("ask:release")
              ? 0
              : issues.some(
                    (blocked) =>
                      blocked.host === issue.host &&
                      blocked.repository === issue.repository &&
                      blocked.blockedBy?.includes(issue.number),
                  )
                ? 1
                : issue.decision?.deadline
                  ? 2
                  : 3,
            blockingTaskIds: issues
              .filter(
                (blocked) =>
                  blocked.host === issue.host &&
                  blocked.repository === issue.repository &&
                  blocked.blockedBy?.includes(issue.number),
              )
              .map((blocked) => issueId(blocked.host, blocked.repository, blocked.number)),
            title: issue.title,
            kind: issue.decision
              ? "decision"
              : issue.stage === "needs-test" || issue.labels.includes("needs-test")
                ? "test"
                : "review",
            url: issue.url,
            threadId:
              waitingThreads.get(id) ?? issue.owner?.threadId ?? issue.linkedThreadIds[0] ?? null,
            updatedAt: issue.updatedAt,
            deadline: issue.decision?.deadline ?? null,
            question: (issue.decision?.context ?? issue.title).slice(0, 1500),
            sourceId,
          });
        }
        return {
          id,
          sourceId,
          closedAt: issue.closedAt,
          ...(issue.rank !== undefined ? { rank: issue.rank } : {}),
          createdAt: issue.createdAt,
          ...(issue.placedBy !== undefined ? { placedBy: issue.placedBy } : {}),
          ...(parent != null ? { partOf: parent } : {}),
          ...(issue.isRequest
            ? { kind: labels.has("ask:question") && !labels.has("ask:task") ? "question" : "task" }
            : {}),
          ...(labels.has("bug") ? { bug: true } : {}),
          ...(labels.has("parked") ? { parked: true } : {}),
          ...(tracker && issue.plan ? { hasChecklist: issue.plan.hasChecklist } : {}),
          ...(issue.membershipWarnings ? { membershipWarnings: issue.membershipWarnings } : {}),
          title: issue.title,
          url: issue.url,
          threadId: waitingThreads.get(id) ?? linked?.id ?? issue.linkedThreadIds[0] ?? null,
          workstreamId: parent
            ? issueId(issue.host, issue.repository, parent)
            : `project:${root.id}:work`,
          status:
            issue.status === "done"
              ? "done"
              : attentionIds.length > 0 || (issue.blockedBy?.length ?? 0) > 0
                ? "blocked"
                : issue.status === "needs-review"
                  ? "review"
                  : issue.status === "in-progress"
                    ? "working"
                    : "pending",
          progress,
          movement: movement(id, progress, history, input.now),
          forecast:
            tracker && issue.dueDate
              ? {
                  eta: issue.dueDate,
                  precision: "date" as const,
                  basis: "owner" as const,
                  sourceId,
                }
              : null,
          nextStep:
            tracker && issue.plan
              ? issue.plan.nextStep
              : (linked?.todoProgress?.currentStep?.text ?? null),
          attentionIds,
        };
      });
    // A to-do list is a real plan, but a thread without a plan is not executive progress. Only
    // threads still at work, or stopped with steps left (resumable), keep a row; finished ones drop.
    for (const thread of tree) {
      const resumable = isThreadResumable(thread);
      if (
        localOwners.get(thread.id) !== root.id ||
        !thread.todoProgress ||
        thread.todoProgress.total === 0 ||
        thread.todoProgress.completed >= thread.todoProgress.total ||
        !(isThreadInFlight(thread) || resumable) ||
        // The thread an issue row shows is covered by it. Another linked thread keeps its own row
        // only when it is stopped and resumable (say a dead worker beside the head the row resolves
        // to); an in-flight one is covered by its issue and must not add a second row.
        tasks.some((task) => task.threadId === thread.id) ||
        (!resumable && issues.some((i) => i.linkedThreadIds.includes(thread.id)))
      )
        continue;
      const id = `thread-plan:${thread.id}`;
      const progress = {
        done: thread.todoProgress.completed,
        total: thread.todoProgress.total,
        planVersion: `todo:${thread.id}:${thread.todoProgress.total}`,
        sourceId: "local",
        confirmedAt: DateTime.formatIso(thread.updatedAt),
      };
      tasks.push({
        id,
        sourceId: "local",
        closedAt: null,
        title: thread.title,
        url: null,
        threadId: thread.id,
        workstreamId: `project:${root.id}:work`,
        // A stopped thread is neither working nor stalled-by-idle: "blocked" keeps it out of both.
        status: resumable ? "blocked" : "working",
        // An issue row that borrows this thread's steps already counts them; the dashboard totals
        // sum task progress, so this row shows none.
        progress: progressSources.has(thread.id) ? null : progress,
        // Stopped work is frozen: no gain or pace forecast from before it stopped.
        movement: resumable
          ? movement(id, null, history, input.now)
          : movement(id, progress, history, input.now),
        forecast: null,
        nextStep: thread.todoProgress.currentStep?.text ?? null,
        attentionIds: [],
      });
    }
    for (const ask of input.pendingAsks ?? []) {
      if (localOwners.get(ask.threadId) !== root.id) continue;
      const task = tasks.find((t) => t.threadId === ask.threadId);
      const id = `runtime:${ask.threadId}:${ask.requestId}`;
      const taskId = task?.id ?? `thread-plan:${ask.threadId}`;
      if (!task)
        tasks.push({
          id: taskId,
          sourceId: "local",
          closedAt: null,
          title: ask.threadTitle,
          url: null,
          threadId: ask.threadId,
          workstreamId: `project:${root.id}:work`,
          status: "blocked",
          progress: null,
          movement: movement(taskId, null, history, input.now),
          forecast: null,
          nextStep: null,
          attentionIds: [id],
        });
      else Object.assign(task, { status: "blocked", attentionIds: [...task.attentionIds, id] });
      attention.push({
        id,
        taskId,
        blockingTaskIds: [taskId],
        requestId: ask.requestId,
        title: ask.threadTitle,
        kind: ask.kind === "question" ? "question" : "approval",
        canRespond: ask.canRespond,
        options:
          ask.kind === "question"
            ? ask.questions.flatMap((q) =>
                q.options.map((o) => ({ text: o.label, recommended: false })),
              )
            : [],
        priority: 1,
        url: null,
        threadId: ask.threadId,
        updatedAt: ask.createdAt,
        deadline: null,
        question: (ask.kind === "question"
          ? ask.questions.map((q) => q.question).join("\n")
          : (ask.detail ?? "Approval requested")
        ).slice(0, 1500),
        sourceId: "local",
      });
    }
    for (const task of tasks) {
      const blocking = attention.filter((a) => a.blockingTaskIds.includes(task.id));
      if (blocking.length)
        Object.assign(task, {
          attentionIds: [...new Set([...task.attentionIds, ...blocking.map((a) => a.id)])],
        });
    }
    const headers = tracker
      ? issues.filter((issue) => issue.epic && issue.plan && issue.status !== "done")
      : [];
    const headerIds = new Set(
      headers.map((issue) => issueId(issue.host, issue.repository, issue.number)),
    );
    const planTasks = tasks
      .filter((task) => !headerIds.has(task.id) || task.attentionIds.length > 0)
      .map((task) => (headerIds.has(task.id) ? { ...task, progress: null } : task));
    const workstreams = headers.map<DashboardProject["workstreams"][number]>((issue) => {
      const id = issueId(issue.host, issue.repository, issue.number);
      return {
        id,
        title: issue.title,
        url: issue.url,
        threadId:
          issue.linkedThreadIds.find((id) => tree.some((thread) => thread.id === id)) ?? null,
        rank: issue.rank ?? null,
        ...(issue.membershipWarnings ? { membershipWarnings: issue.membershipWarnings } : {}),
        createdAt: issue.createdAt,
        placedBy: issue.placedBy ?? null,
        parentWorkstreamId: issue.partOf
          ? issueId(issue.host, issue.repository, issue.partOf)
          : null,
        progress:
          issue.epic!.total > 0
            ? {
                done: issue.epic!.done,
                total: issue.epic!.total,
                planVersion: issue.plan!.planVersion,
                confirmedAt: issue.plan!.confirmedAt ?? UNCONFIRMED_AT,
                confirmationKnown: issue.plan!.confirmedAt !== null,
                sourceId: `gitea:${issue.host}/${issue.repository}`,
              }
            : null,
        childIssueIds: (issue.epic!.children ?? []).map((number) =>
          issueId(issue.host, issue.repository, number),
        ),
        unknownChildIds: (issue.epic!.unknown ?? []).map((number) =>
          issueId(issue.host, issue.repository, number),
        ),
        taskIds: planTasks.filter((task) => task.workstreamId === id).map((task) => task.id),
      };
    });
    for (const id of new Set(planTasks.map((task) => task.workstreamId)))
      if (!workstreams.some((w) => w.id === id))
        workstreams.push({
          id,
          title: id === `project:${root.id}:work` ? "Unsorted" : "Work",
          url: null,
          threadId: null,
          rank: null,
          createdAt: root.updatedAt ? DateTime.formatIso(root.updatedAt) : input.now,
          placedBy: null,
          parentWorkstreamId: null,
          progress: null,
          childIssueIds: [],
          unknownChildIds: [],
          taskIds: planTasks.filter((task) => task.workstreamId === id).map((task) => task.id),
        });
    let parent = root.parentThreadId;
    const seen = new Set<ThreadId>();
    while (parent && !roots.some((r) => r.id === parent) && !seen.has(parent)) {
      seen.add(parent);
      parent = threads.find((t) => t.id === parent)?.parentThreadId ?? null;
    }
    const priorProject = input.previous?.projects.find(
      (project) => project.rootThreadId === root.id,
    );
    const priorHeads = input.plans
      .filter((plan) => boundPlans.get(plan) === root.id)
      .flatMap(
        (plan) =>
          input.previous?.projects.filter((project) => project.id === `head:${plan.head}`) ?? [],
      );
    const removedPlanTaskIds = [
      ...new Set(
        [...(priorProject?.tasks ?? []), ...priorHeads.flatMap((project) => project.tasks)]
          .filter(
            (task) =>
              task.id.startsWith("plan:") && !planTasks.some((current) => current.id === task.id),
          )
          .map((task) => task.id),
      ),
    ];
    const planMigration = tracker
      ? (priorProject?.planMigration ??
        (removedPlanTaskIds.length > 0
          ? { observedAt: input.now, removedTaskIds: removedPlanTaskIds }
          : undefined))
      : undefined;
    projects.push({
      planSource: tracker ? "tracker" : "briefing",
      ...(planMigration ? { planMigration } : {}),
      id: `project:${root.id}`,
      rootThreadId: root.id,
      parentId: parent ? `project:${parent}` : null,
      title: root.title,
      utility: utility(root.title),
      omittedTaskCount: 0,
      tasks: planTasks,
      attention,
      workstreams,
      sourceIds: [
        ...new Set([
          "local",
          ...tasks.flatMap((t) => [t.sourceId, ...(t.progress ? [t.progress.sourceId] : [])]),
        ]),
      ],
    });
  }
  for (const plan of fallbackPlans) {
    const sourceId = `plan:${plan.head}`;
    const orphan: DashboardTask[] = [];
    const ids = new Set<string>();
    const duplicateIds = new Set(
      plan.workstreams
        .flatMap((b) => b.tasks)
        .filter((t, i, all) => all.findIndex((other) => other.id === t.id) !== i)
        .map((t) => t.id),
    );
    for (const band of plan.workstreams)
      for (const task of band.tasks) {
        if (
          ids.has(task.id) ||
          duplicateIds.has(task.id) ||
          (task.steps_done === task.steps_total &&
            Date.parse(input.now) - Date.parse(task.updated_utc) > 24 * 60 * 60_000)
        )
          continue;
        ids.add(task.id);
        if (
          task.steps_done < 0 ||
          task.steps_total < task.steps_done ||
          task.steps_total <= 0 ||
          !Number.isFinite(Date.parse(task.updated_utc))
        )
          continue;
        const linkedRoot = task.link ? issueUrlOwners.get(task.link) : undefined;
        const boundRoot = boundPlans.get(plan);
        // A legacy or cross-project link cannot change another root's selected Plan source.
        const foreign =
          linkedRoot && (trackerRoots.has(linkedRoot) || (boundRoot && boundRoot !== linkedRoot));
        const existing =
          task.link && !foreign
            ? projects.flatMap((p) => p.tasks).find((t) => t.url === task.link)
            : undefined;
        const id = existing?.id ?? `plan:${plan.head}:${task.id}`;
        const progress = {
          done: task.steps_done,
          total: task.steps_total,
          planVersion: `plan:${plan.head}:${task.id}:${task.steps_total}`,
          sourceId,
          confirmedAt: task.updated_utc,
        };
        const forecast =
          task.eta_utc &&
          Number.isFinite(Date.parse(task.eta_utc)) &&
          Date.parse(input.now) - Date.parse(task.updated_utc) <= 2 * 60 * 60_000
            ? { eta: task.eta_utc, basis: "owner" as const, sourceId }
            : null;
        if (existing) {
          Object.assign(existing, {
            progress,
            movement: movement(id, progress, history, input.now),
            forecast,
            nextStep: task.next_step,
          });
        } else
          orphan.push({
            id,
            sourceId,
            closedAt:
              task.steps_done === task.steps_total
                ? DateTime.formatIso(DateTime.makeUnsafe(task.updated_utc))
                : null,
            title: task.title,
            url: task.link || null,
            threadId: null,
            workstreamId: `plan:${plan.head}:${band.id}`,
            status: task.steps_done === task.steps_total ? "done" : "working",
            progress,
            movement: movement(id, progress, history, input.now),
            forecast,
            nextStep: task.next_step,
            attentionIds: [],
          });
      }
    const boundRoot = boundPlans.get(plan);
    const boundProject = boundRoot
      ? projects.find((project) => project.rootThreadId === boundRoot)
      : undefined;
    if (orphan.length && boundProject) {
      Object.assign(boundProject, { tasks: [...boundProject.tasks, ...orphan] });
      Object.assign(boundProject, {
        workstreams: [
          ...boundProject.workstreams,
          ...plan.workstreams.map((band) => ({
            id: `plan:${plan.head}:${band.id}`,
            title: band.title,
            taskIds: orphan
              .filter((task) => task.workstreamId === `plan:${plan.head}:${band.id}`)
              .map((task) => task.id),
          })),
        ],
      });
    } else if (orphan.length)
      projects.push({
        id: `head:${plan.head}`,
        rootThreadId: null,
        parentId: null,
        title: plan.title,
        utility: utility(plan.head),
        omittedTaskCount: 0,
        tasks: orphan,
        attention: [],
        workstreams: plan.workstreams.map((b) => ({
          id: `plan:${plan.head}:${b.id}`,
          title: b.title,
          taskIds: orphan
            .filter((t) => t.workstreamId === `plan:${plan.head}:${b.id}`)
            .map((t) => t.id),
        })),
        sourceIds: [sourceId],
      });
  }
  for (const project of projects) {
    Object.assign(project, {
      sourceIds: [
        ...new Set([
          ...project.sourceIds,
          ...project.tasks.flatMap((t) => [
            t.sourceId,
            ...(t.progress ? [t.progress.sourceId] : []),
          ]),
          ...project.attention.map((a) => a.sourceId),
        ]),
      ],
    });
    if (project.workstreams.length === 0)
      Object.assign(project, {
        workstreams: [...new Set(project.tasks.map((t) => t.workstreamId))].map((id) => ({
          id,
          title: project.tasks.find((t) => t.id === id)?.title ?? "Work",
          taskIds: project.tasks.filter((t) => t.workstreamId === id).map((t) => t.id),
        })),
      });
    Object.assign(project, {
      attention: [...project.attention].sort(
        (a, b) =>
          a.priority - b.priority ||
          (a.deadline ?? "9999").localeCompare(b.deadline ?? "9999") ||
          b.updatedAt.localeCompare(a.updatedAt),
      ),
    });
  }
  for (const task of projects.flatMap((p) => p.tasks)) {
    const previous = input.previous?.projects
      .flatMap((p) => p.tasks)
      .find((t) => t.id === task.id)?.progress;
    if (
      task.progress?.sourceId === "local" &&
      previous &&
      previous.done === task.progress.done &&
      previous.total === task.progress.total &&
      previous.planVersion === task.progress.planVersion
    ) {
      const progress = { ...task.progress, confirmedAt: previous.confirmedAt };
      Object.assign(task, {
        progress,
        movement: movement(task.id, progress, history, input.now),
      });
    }
  }
  for (const task of projects.flatMap((p) => p.tasks)) {
    const receipt = input.sources.find((s) => s.id === task.progress?.sourceId);
    if (
      receipt &&
      (receipt.failed ||
        !receipt.lastSuccessAt ||
        Date.parse(input.now) - Date.parse(receipt.lastSuccessAt) > receipt.staleAfterMs)
    )
      Object.assign(task, {
        movement: movement(task.id, null, history, input.now),
        forecast: null,
      });
  }
  const releases = fallbackPlans.flatMap((plan) =>
    plan.workstreams.flatMap((band) =>
      band.tasks
        .filter(
          (t) =>
            t.kind === "release" &&
            !(
              t.link &&
              issueUrlOwners.has(t.link) &&
              trackerRoots.has(issueUrlOwners.get(t.link)!)
            ) &&
            !(
              t.steps_done === t.steps_total &&
              Date.parse(input.now) - Date.parse(t.updated_utc) > 24 * 60 * 60_000
            ),
        )
        .map((task) => {
          const linked = projects
            .flatMap((p) => p.tasks)
            .find((t) => task.link && t.url === task.link);
          return {
            id: `plan-release:${plan.head}:${task.id}`,
            title: task.title,
            taskId: linked?.id ?? `plan:${plan.head}:${task.id}`,
            installedVersion: null,
            latestVersion: null,
            sourceId: `plan:${plan.head}`,
          };
        }),
    ),
  );
  const planMigration = input.plans
    .filter((plan) => plan.source === "tracker" && !boundPlans.get(plan))
    .map((plan) => ({
      kind: "unbound-briefing-file" as const,
      fileName: plan.fileName ?? `${plan.head}.json`,
      reason: plan.rootThreadId
        ? "Root ID does not match an active project"
        : "No unique exact-title binding",
    }));
  return {
    ...emptySnapshot(input.now),
    projects,
    releases,
    sources: [...input.sources],
    ...(planMigration.length ? { planMigration } : {}),
  };
}

export function rootRepositories(
  shell: OrchestrationV2ShellSnapshot,
): ReadonlyMap<ThreadId, string> {
  const result = new Map<ThreadId, string>();
  for (const thread of shell.threads) {
    const repo = shell.projects.find((p) => p.id === thread.projectId)?.repositoryIdentity;
    const locator = repo?.webUrl ?? repo?.locator.remoteUrl;
    if (locator) {
      try {
        const normalized = locator.replace(/^[^@/]+@([^:]+):/, "https://$1/");
        const url = new URL(normalized);
        result.set(
          thread.id,
          `${url.host}/${url.pathname
            .replace(/^\//, "")
            .replace(/\.git$/, "")
            .replace(/\/$/, "")}`,
        );
      } catch {
        /* Unresolved identity remains unknown. */
      }
    }
  }
  return result;
}
