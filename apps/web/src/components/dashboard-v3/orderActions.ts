import {
  issueNumber,
  planMove,
  type MoveTo,
  type PlaceStep,
  type PlaceTarget,
} from "@t3tools/client-runtime/dashboard/order";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type {
  DashboardTask,
  EnvironmentId,
  ProjectRequestPlace,
  ThreadId,
} from "@t3tools/contracts";
import { useCallback, useMemo } from "react";

import { useServerConfigs } from "../../state/entities";
import {
  orderProjectRequest,
  settleProjectRequest,
  updateProjectRequest,
} from "../../state/projectIssues";
import { moveRoadmapItem } from "../../state/projectRoadmap";
import { useAtomCommand } from "../../state/use-atom-command";
import type { ScopedProject } from "./dashboard.logic";
import { parseIssueTaskId } from "./dashboard.logic";

/** The one line under the request box: what just happened, and the way back from it. */
export interface DashboardNotice {
  readonly id: number;
  readonly tone: "ok" | "warn" | "error";
  readonly text: string;
  readonly actions: ReadonlyArray<{ readonly label: string; readonly run: () => void }>;
}
export type ReportNotice = (notice: Omit<DashboardNotice, "id">) => void;

/** "1st", "2nd", "11th": a position said aloud. */
export function ordinal(n: number): string {
  const rest = n % 100;
  if (rest >= 11 && rest <= 13) return `${n}th`;
  return `${n}${(["th", "st", "nd", "rd"] as const)[n % 10 > 3 ? 0 : n % 10]}`;
}

/** The workstream a snapshot task belongs to as an epic number; null for the non-epic group. */
export const epicNumber = (task: Pick<DashboardTask, "partOf">) => task.partOf ?? null;

/** What an order write needs to know of an item: a task, or an epic when a workstream moves. */
export interface Subject {
  readonly id: string;
  readonly rank?: number | null | undefined;
  readonly partOf?: number | null | undefined;
}

/** What a placement says about the item, for the "Saved" line. */
export interface Destination {
  /** The epic the item belongs to, or null for Other work. */
  readonly partOf: number | null;
  readonly title: string;
}

export interface PlaceRequest {
  readonly destination: Destination;
  /** The destination's queued rows, in order, without a row that is being moved in. */
  readonly list: ReadonlyArray<Subject>;
  readonly move: MoveTo;
  /** The queued rows the item sits in now; empty when it comes from New. */
  readonly origin: ReadonlyArray<Subject>;
  /** Set when a workstream (its epic) is the item moved: the line then names it, not "#N". */
  readonly workstream?: string;
}

export interface OrderActions {
  /** Order controls show for a tracker project on a server that stores the order. */
  readonly canOrder: (scoped: ScopedProject) => boolean;
  /** The request line files into a project with a thread of its own on such a server. */
  readonly canFile: (scoped: ScopedProject) => boolean;
  readonly place: (scoped: ScopedProject, subject: Subject, request: PlaceRequest) => Promise<void>;
  readonly backToNew: (
    scoped: ScopedProject,
    task: DashboardTask,
    origin: ReadonlyArray<Subject>,
  ) => Promise<void>;
  readonly setType: (
    scoped: ScopedProject,
    task: DashboardTask,
    type: "task" | "bug" | "epic",
  ) => Promise<void>;
  readonly duplicateOf: (
    scoped: ScopedProject,
    task: DashboardTask,
    reference: string,
  ) => Promise<void>;
  readonly later: (scoped: ScopedProject, task: DashboardTask) => Promise<void>;
  /** Moves a New item to another workstream without ordering it: it stays in New. */
  readonly keepNew: (
    scoped: ScopedProject,
    task: DashboardTask,
    destination: Destination,
  ) => Promise<void>;
}

const numberOf = (task: Pick<Subject, "id">) => issueNumber(task.id);
const reference = (task: Pick<Subject, "id">) => String(numberOf(task) ?? "");
const label = (task: Pick<Subject, "id">) => `#${numberOf(task) ?? "?"}`;

export function failureText(result: unknown): string {
  const error = squashAtomCommandFailure(result as never);
  return error instanceof Error && error.message ? error.message : "Could not reach the server.";
}

/** A placement as the server takes it: references are issue numbers, never ranks. */
export const toProjectPlace = (place: PlaceTarget): ProjectRequestPlace =>
  place.to === "before" || place.to === "after"
    ? { to: place.to, reference: String(numberOf({ id: place.id }) ?? "") }
    : { to: place.to };

/**
 * Brad's order actions on one environment. Every write is one server call that refreshes the
 * snapshot at once; nothing is shown that the tracker has not accepted, and each action says what
 * it did on the notice line with the way back.
 */
export function useOrderActions(report: ReportNotice): OrderActions {
  const configs = useServerConfigs();
  const order = useAtomCommand(orderProjectRequest, { reportFailure: false });
  const update = useAtomCommand(updateProjectRequest, { reportFailure: false });
  const settle = useAtomCommand(settleProjectRequest, { reportFailure: false });
  const roadmapMove = useAtomCommand(moveRoadmapItem, { reportFailure: false });

  const supported = useCallback(
    (environmentId: EnvironmentId) =>
      configs.get(environmentId)?.environment.capabilities.projectRequestOrder === true,
    [configs],
  );
  const canFile = useCallback(
    (scoped: ScopedProject) =>
      scoped.project.rootThreadId !== null && supported(scoped.environmentId),
    [supported],
  );
  const canOrder = useCallback(
    (scoped: ScopedProject) => canFile(scoped) && scoped.project.planSource === "tracker",
    [canFile],
  );

  return useMemo<OrderActions>(() => {
    const threadOf = (scoped: ScopedProject) => scoped.project.rootThreadId as ThreadId;

    const runSteps = async (
      scoped: ScopedProject,
      task: Subject,
      steps: ReadonlyArray<PlaceStep>,
    ) => {
      let position: number | null = null;
      for (const step of steps) {
        const target = step.id === task.id ? task : { id: step.id };
        const result = await order({
          environmentId: scoped.environmentId,
          input: {
            threadId: threadOf(scoped),
            reference: reference(target),
            place: toProjectPlace(step.place),
            actor: "brad",
          },
        });
        if (result._tag !== "Success") throw new Error(failureText(result));
        if (step.id === task.id) position = result.value.position;
      }
      return position;
    };

    const setPartOf = async (scoped: ScopedProject, task: Subject, partOf: number | null) => {
      const result = await update({
        environmentId: scoped.environmentId,
        input: { threadId: threadOf(scoped), reference: reference(task), partOf, actor: "brad" },
      });
      if (result._tag !== "Success") throw new Error(failureText(result));
    };

    /** Puts the item back where `origin` had it: before its old successor, last, or back in New. */
    const restore = async (
      scoped: ScopedProject,
      task: Subject,
      origin: ReadonlyArray<Subject>,
      reparented: boolean,
    ) => {
      if (reparented) await setPartOf(scoped, task, task.partOf ?? null);
      if ((task.rank ?? null) === null) {
        await runSteps(scoped, task, [{ id: task.id, place: { to: "none" } }]);
        return;
      }
      const at = origin.findIndex((row) => row.id === task.id);
      const successor =
        at >= 0 ? origin.slice(at + 1).find((row) => (row.rank ?? null) !== null) : undefined;
      await runSteps(scoped, task, [
        { id: task.id, place: successor ? { to: "before", id: successor.id } : { to: "bottom" } },
      ]);
    };

    const fail = (error: unknown) =>
      error instanceof Error && error.message ? error.message : "Could not save.";

    const undoNotice = async (undo: () => Promise<void>) => {
      try {
        await undo();
        report({ tone: "ok", text: "Undone.", actions: [] });
      } catch (error) {
        report({ tone: "error", text: `Could not undo: ${fail(error)}`, actions: [] });
      }
    };

    const guarded = async (
      attempt: () => Promise<{ text: string; undo?: () => Promise<void> }>,
      retry: () => Promise<void>,
    ) => {
      try {
        const done = await attempt();
        const undo = done.undo;
        report({
          tone: "ok",
          text: done.text,
          actions: undo ? [{ label: "Undo", run: () => void undoNotice(undo) }] : [],
        });
      } catch (error) {
        report({
          tone: "error",
          text: `Could not save: ${fail(error)}`,
          actions: [{ label: "Retry", run: () => void retry() }],
        });
      }
    };

    const actions: OrderActions = {
      canOrder,
      canFile,
      place: async (scoped, task, request) => {
        const moved = (task.partOf ?? null) !== request.destination.partOf;
        const retry = () => actions.place(scoped, task, request);
        await guarded(async () => {
          if (moved) await setPartOf(scoped, task, request.destination.partOf);
          const position = await runSteps(
            scoped,
            task,
            planMove(request.list, task.id, request.move),
          );
          const where = request.destination.title;
          return {
            text: request.workstream
              ? position === null
                ? `${request.workstream} is placed.`
                : `Saved: ${request.workstream} is workstream ${position}.`
              : position === null
                ? `${label(task)} is in ${where}.`
                : `Saved: ${label(task)} is ${ordinal(position)} in ${where}.`,
            undo: () => restore(scoped, task, request.origin, moved),
          };
        }, retry);
      },
      keepNew: async (scoped, task, destination) => {
        await guarded(
          async () => {
            await setPartOf(scoped, task, destination.partOf);
            return {
              text: `${label(task)} is in ${destination.title}, still in New.`,
              undo: () => setPartOf(scoped, task, task.partOf ?? null),
            };
          },
          () => actions.keepNew(scoped, task, destination),
        );
      },
      backToNew: async (scoped, task, origin) => {
        await guarded(
          async () => {
            await runSteps(scoped, task, [{ id: task.id, place: { to: "none" } }]);
            return {
              text: `${label(task)} is back in New.`,
              undo: () => restore(scoped, task, origin, false),
            };
          },
          () => actions.backToNew(scoped, task, origin),
        );
      },
      setType: async (scoped, task, type) => {
        await guarded(
          async () => {
            const result = await update({
              environmentId: scoped.environmentId,
              input: {
                threadId: threadOf(scoped),
                reference: reference(task),
                kind: type === "epic" ? "epic" : "task",
                bug: type === "bug",
                actor: "brad",
              },
            });
            if (result._tag !== "Success") throw new Error(failureText(result));
            const was = task.bug ? "bug" : "task";
            return {
              text: `${label(task)} is now ${type === "bug" ? "a bug" : type === "epic" ? "an epic" : "a task"}.`,
              undo: async () => {
                const back = await update({
                  environmentId: scoped.environmentId,
                  input: {
                    threadId: threadOf(scoped),
                    reference: reference(task),
                    kind: "task",
                    bug: was === "bug",
                    actor: "brad",
                  },
                });
                if (back._tag !== "Success") throw new Error(failureText(back));
              },
            };
          },
          () => actions.setType(scoped, task, type),
        );
      },
      duplicateOf: async (scoped, task, target) => {
        await guarded(
          async () => {
            const result = await update({
              environmentId: scoped.environmentId,
              input: {
                threadId: threadOf(scoped),
                reference: reference(task),
                duplicateOf: target,
                actor: "brad",
              },
            });
            if (result._tag !== "Success") throw new Error(failureText(result));
            const parsed = parseIssueTaskId(task.id);
            return {
              text: `${label(task)} closed as a duplicate of ${target.startsWith("#") ? target : `#${target}`}.`,
              undo: async () => {
                if (!parsed) throw new Error("Could not reopen it.");
                const back = await settle({
                  environmentId: scoped.environmentId,
                  input: {
                    rootThreadId: threadOf(scoped),
                    host: parsed.host,
                    repository: parsed.repository,
                    number: parsed.number,
                    reopen: true,
                  },
                });
                if (back._tag !== "Success") throw new Error(failureText(back));
              },
            };
          },
          () => actions.duplicateOf(scoped, task, target),
        );
      },
      later: async (scoped, task) => {
        await guarded(
          async () => {
            const result = await roadmapMove({
              environmentId: scoped.environmentId,
              input: {
                threadId: threadOf(scoped),
                reference: reference(task),
                version: null,
                later: true,
              },
            });
            if (result._tag !== "Success") throw new Error(failureText(result));
            return {
              text: `${label(task)} moved to Later.`,
              undo: async () => {
                const back = await roadmapMove({
                  environmentId: scoped.environmentId,
                  input: { threadId: threadOf(scoped), reference: reference(task), version: null },
                });
                if (back._tag !== "Success") throw new Error(failureText(back));
              },
            };
          },
          () => actions.later(scoped, task),
        );
      },
    };
    return actions;
  }, [canFile, canOrder, order, report, roadmapMove, settle, update]);
}
