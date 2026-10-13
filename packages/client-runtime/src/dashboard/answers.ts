import type {
  DashboardSnapshot,
  EnvironmentId,
  ProjectRequestDecideInput,
} from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { overlayAnswered } from "./merge.ts";

export interface DashboardAnswer {
  readonly environmentId: EnvironmentId;
  readonly reference: string;
  readonly rootThreadId: string;
  readonly at: number;
  readonly attentionId?: string;
}
const decisionIdentities = new Map<EnvironmentId, ReadonlyMap<string, string>>();
/** Resolve acknowledged references to the global issue identity before another host can show a stale copy. */
export function registerDashboardDecisions(
  environmentId: EnvironmentId,
  snapshot: DashboardSnapshot,
) {
  const identities = new Map<string, string>();
  const ambiguous = new Set<string>();
  for (const project of snapshot.projects)
    for (const attention of project.attention) {
      const match = /^issue:[^/]+\/(.+)#(\d+)$/.exec(attention.taskId);
      const task = project.tasks.find((t) => t.id === attention.taskId);
      for (const reference of [task?.url, match ? `${match[1]}#${match[2]}` : null]) {
        if (!reference) continue;
        const key = `${project.rootThreadId}|${reference}`;
        if (identities.has(key) && identities.get(key) !== attention.id) ambiguous.add(key);
        else identities.set(key, attention.id);
      }
    }
  for (const key of ambiguous) identities.delete(key);
  decisionIdentities.set(environmentId, identities);
}
export const dashboardAnswersAtom = Atom.make<readonly DashboardAnswer[]>([]).pipe(Atom.keepAlive);

/** Match the acknowledged mutation's exact URL or repository reference, never a bare cross-repo number. */
export function overlayDashboardAnswers(
  snapshot: DashboardSnapshot,
  environmentId: EnvironmentId,
  answers: readonly DashboardAnswer[],
  now: number,
) {
  const ids = new Map<string, number>();
  for (const answer of answers) {
    if (now - answer.at >= 5 * 60_000) continue;
    if (answer.attentionId) {
      ids.set(answer.attentionId, answer.at);
      continue;
    }
    if (answer.environmentId !== environmentId) continue;
    for (const project of snapshot.projects) {
      if (project.rootThreadId !== answer.rootThreadId) continue;
      for (const attention of project.attention) {
        const task = project.tasks.find((t) => t.id === attention.taskId);
        const match = /^issue:[^/]+\/(.+)#(\d+)$/.exec(attention.taskId);
        if (
          task?.url === answer.reference ||
          (match && `${match[1]}#${match[2]}` === answer.reference)
        )
          ids.set(attention.id, answer.at);
      }
    }
  }
  return overlayAnswered(snapshot, ids, now);
}
export function dashboardAnswer(
  environmentId: EnvironmentId,
  input: ProjectRequestDecideInput,
  at: number,
): DashboardAnswer {
  const attentionId = decisionIdentities
    .get(environmentId)
    ?.get(`${input.threadId}|${input.reference}`);
  return {
    environmentId,
    reference: input.reference,
    rootThreadId: input.threadId,
    at,
    ...(attentionId ? { attentionId } : {}),
  };
}

/** A complete, healthy read after the answer may release the temporary suppression. */
export function dashboardAnswerConfirmed(
  snapshot: DashboardSnapshot,
  answer: DashboardAnswer,
): boolean {
  if (Date.parse(snapshot.asOf) < answer.at) return false;
  const project = snapshot.projects.find((p) => p.rootThreadId === answer.rootThreadId);
  if (!project || project.omittedTaskCount > 0) return false;
  if (
    project.sourceIds.some((id) => {
      const source = snapshot.sources.find((s) => s.id === id);
      return !source || source.failed || source.coverage === "unavailable";
    })
  )
    return false;
  return !project.attention.some((attention) => {
    const task = project.tasks.find((t) => t.id === attention.taskId);
    const match = /^issue:[^/]+\/(.+)#(\d+)$/.exec(attention.taskId);
    return (
      task?.url === answer.reference || !!(match && `${match[1]}#${match[2]}` === answer.reference)
    );
  });
}
