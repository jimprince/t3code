import {
  MessageId,
  ThreadId,
  type OrchestrationCommand,
  type OrchestrationProject,
  type OrchestrationThread,
  type ProjectAutomation,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { OrchestrationCommandInvariantError } from "./Errors.ts";
import { latestAutomationRun, nextAutomationRun } from "./projectAutomationSchedule.ts";

type Command = Extract<OrchestrationCommand, { type: `project.automation.${string}` }>;

/** Automation transitions share the project's event-sourced metadata projection. */
export const decideProjectAutomation = Effect.fn("decideProjectAutomation")(function* (
  project: OrchestrationProject,
  command: Command,
  threads: readonly OrchestrationThread[],
  now: string,
) {
  if (project.deletedAt !== null)
    return yield* new OrchestrationCommandInvariantError({
      commandType: command.type,
      detail: "Project was deleted.",
    });
  const automations = project.automations ?? [];
  const id = "automation" in command ? command.automation.id : command.automationId;
  const current = automations.find((entry) => entry.id === id);
  const fail = (detail: string) =>
    new OrchestrationCommandInvariantError({ commandType: command.type, detail });
  if (command.type === "project.automation.create") {
    if (current) return yield* fail("Automation already exists.");
    if (automations.length >= 100)
      return yield* fail("A project can have at most 100 automations.");
  } else if (!current) return yield* fail("Automation does not exist.");
  if ("automation" in command) {
    const definition = command.automation;
    if (
      definition.ownerThreadId &&
      !threads.some(
        (thread) =>
          thread.id === definition.ownerThreadId &&
          thread.projectId === project.id &&
          thread.deletedAt === null,
      )
    )
      return yield* fail("Owner thread must belong to this project.");
    if (definition.target.kind === "existing-thread") {
      const targetId = definition.target.threadId;
      const target = threads.find((entry) => entry.id === targetId);
      if (!target || target.projectId !== project.id || target.deletedAt !== null)
        return yield* fail("Target thread must belong to this project.");
    }
    const updated: ProjectAutomation = {
      ...definition,
      nextRunAt: nextAutomationRun(definition.schedule, now),
      runs: current?.runs ?? [],
    };
    return current
      ? automations.map((entry) => (entry.id === id ? updated : entry))
      : [...automations, updated];
  }
  if (!current) return yield* fail("Automation does not exist.");
  if (command.type === "project.automation.delete")
    return automations.filter((entry) => entry.id !== id);
  let updated = current;
  switch (command.type) {
    case "project.automation.pause":
      updated = { ...current, enabled: false };
      break;
    case "project.automation.resume":
      updated = { ...current, enabled: true, nextRunAt: nextAutomationRun(current.schedule, now) };
      break;
    case "project.automation.run":
    case "project.automation.fire": {
      const scheduled = command.type === "project.automation.fire";
      if (scheduled && (!current.enabled || command.scheduledAt !== current.nextRunAt))
        return automations;
      const scheduledAt = scheduled ? latestAutomationRun(current.schedule, now) : now;
      const runId = scheduled
        ? `${project.id}:${id}:${current.nextRunAt}`
        : `${project.id}:${id}:${command.commandId}`;
      if (current.runs.some((run) => run.id === runId)) return automations;
      const missed = scheduled && Date.parse(now) - Date.parse(scheduledAt) > 86_400_000;
      const threadId =
        current.target.kind === "existing-thread"
          ? current.target.threadId
          : ThreadId.make(`automation:${runId}`);
      const active = current.runs.filter(
        (run) => run.status === "queued" || run.status === "running",
      );
      const full = active.length >= 20;
      if (full && !scheduled) return yield* fail("Too many unfinished automation runs.");
      const history = current.runs
        .filter((run) => run.status !== "queued" && run.status !== "running")
        .slice(0, 10);
      updated = {
        ...current,
        nextRunAt: scheduled ? nextAutomationRun(current.schedule, now) : current.nextRunAt,
        runs: [
          {
            name: current.name,
            target: current.target,
            ...(current.ownerThreadId ? { ownerThreadId: current.ownerThreadId } : {}),
            id: runId,
            scheduledAt,
            threadId,
            messageId: MessageId.make(`automation:${runId}`),
            prompt: current.prompt,
            status: missed || full ? "skipped" : "queued",
            result: full
              ? "Too many unfinished automation runs."
              : missed
                ? "Server missed this schedule by more than 24 hours."
                : null,
            startedAt: null,
            finishedAt: missed || full ? now : null,
          },
          ...active,
          ...history,
        ],
      };
      break;
    }
    case "project.automation.run.update": {
      updated = {
        ...current,
        runs: current.runs.map((run) =>
          run.id === command.runId && (run.status === "queued" || run.status === "running")
            ? {
                ...run,
                status: command.status,
                result: command.result,
                startedAt: command.status === "running" ? (run.startedAt ?? now) : run.startedAt,
                finishedAt:
                  command.status === "completed" || command.status === "failed" ? now : null,
              }
            : run,
        ),
      };
      break;
    }
  }
  return automations.map((entry) => (entry.id === id ? updated : entry));
});
