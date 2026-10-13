import type {
  DashboardAttention,
  DashboardProject,
  DashboardSnapshot,
  DashboardSource,
  DashboardTask,
  ForkThreadMetadata,
  OrchestrationV2ThreadShell,
  ProjectIssue,
  ProjectPendingAsk,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import { collectThreadTree } from "../projectIssues/projectIssues.logic.ts";
import { emptySnapshot, issueId, movement, type ProgressSample } from "./dashboard.logic.ts";

export const BriefingPlan = Schema.Struct({
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
const utility = (title: string) =>
  /^(reliability|quota|quality|security|maintenance|deployment)(\b|$)/i.test(title);
type DashboardShell = Pick<
  OrchestrationV2ThreadShell,
  "id" | "title" | "archivedAt" | "todoProgress" | "updatedAt"
>;
export function dashboardRoots(
  shells: readonly DashboardShell[],
  metadata: readonly ForkThreadMetadata[],
) {
  const parents = new Map(metadata.map((row) => [row.threadId, row]));
  const threads = shells.map((thread) => ({
    ...thread,
    parentThreadId: parents.get(thread.id)?.parentThreadId ?? null,
    subproject: parents.get(thread.id)?.subproject ?? "auto",
  }));
  const active = threads.filter((t) => t.archivedAt === null);
  return {
    threads,
    roots: active.filter(
      (t) =>
        t.subproject === "on" ||
        (!t.parentThreadId && active.some((child) => child.parentThreadId === t.id)),
    ),
  };
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
  readonly previous?: DashboardSnapshot;
}): DashboardSnapshot {
  const { threads, roots } = dashboardRoots(input.shells, input.metadata);
  const projects: DashboardProject[] = [];
  for (const root of roots) {
    const tree = collectThreadTree(threads, root.id);
    const issues = input.issues.get(root.id) ?? [];
    const attention: DashboardAttention[] = [];
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
        const progress = issue.epic
          ? {
              done: issue.epic.done,
              total: issue.epic.total,
              planVersion: `epic:${issue.epic.total}`,
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
        const attentionIds: string[] = [];
        if (
          issue.status !== "done" &&
          (issue.decision || issue.stage === "ready" || issue.stage === "needs-test") &&
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
            kind: issue.decision ? "decision" : issue.stage === "needs-test" ? "test" : "review",
            url: issue.url,
            threadId: issue.owner?.threadId ?? issue.linkedThreadIds[0] ?? null,
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
          title: issue.title,
          url: issue.url,
          threadId: linked?.id ?? issue.linkedThreadIds[0] ?? null,
          workstreamId: issue.partOf
            ? issueId(issue.host, issue.repository, issue.partOf)
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
          movement: movement(id, progress, input.samples, input.now),
          forecast: null,
          nextStep: null,
          attentionIds,
        };
      });
    // A to-do list is a real plan, but a thread without a plan is not executive progress.
    for (const thread of tree) {
      if (
        !thread.todoProgress ||
        thread.todoProgress.total === 0 ||
        issues.some((i) => i.linkedThreadIds.includes(thread.id))
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
        status: progress.done === progress.total ? "done" : "working",
        progress,
        movement: movement(id, progress, input.samples, input.now),
        forecast: null,
        nextStep: null,
        attentionIds: [],
      });
    }
    for (const ask of input.pendingAsks ?? []) {
      if (!tree.some((t) => t.id === ask.threadId)) continue;
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
          movement: movement(taskId, null, input.samples, input.now),
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
    let parent = root.parentThreadId;
    const seen = new Set<ThreadId>();
    while (parent && !roots.some((r) => r.id === parent) && !seen.has(parent)) {
      seen.add(parent);
      parent = threads.find((t) => t.id === parent)?.parentThreadId ?? null;
    }
    projects.push({
      id: `project:${root.id}`,
      rootThreadId: root.id,
      parentId: parent ? `project:${parent}` : null,
      title: root.title,
      utility: utility(root.title),
      omittedTaskCount: 0,
      tasks,
      attention,
      workstreams: [],
      sourceIds: [
        ...new Set([
          "local",
          ...tasks.flatMap((t) => [t.sourceId, ...(t.progress ? [t.progress.sourceId] : [])]),
        ]),
      ],
    });
  }
  for (const plan of input.plans) {
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
        const existing = task.link
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
            movement: movement(id, progress, input.samples, input.now),
            forecast,
            nextStep: task.next_step,
          });
        } else
          orphan.push({
            id,
            sourceId,
            closedAt: null,
            title: task.title,
            url: task.link || null,
            threadId: null,
            workstreamId: `plan:${plan.head}:${band.id}`,
            status: task.steps_done === task.steps_total ? "done" : "working",
            progress,
            movement: movement(id, progress, input.samples, input.now),
            forecast,
            nextStep: task.next_step,
            attentionIds: [],
          });
      }
    if (orphan.length)
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
      attention: project.attention.toSorted(
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
        movement: movement(task.id, progress, input.samples, input.now),
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
        movement: movement(task.id, null, input.samples, input.now),
        forecast: null,
      });
  }
  const releases = input.plans.flatMap((plan) =>
    plan.workstreams.flatMap((band) =>
      band.tasks
        .filter((t) => t.kind === "release")
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
  return { ...emptySnapshot(input.now), projects, releases, sources: [...input.sources] };
}
