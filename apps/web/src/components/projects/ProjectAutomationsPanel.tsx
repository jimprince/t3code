import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import {
  createEnvironmentRpcCommand,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  CommandId,
  ORCHESTRATION_WS_METHODS,
  ProjectAutomationDefinition,
  type ClientOrchestrationCommand,
  type EnvironmentId,
  type ProjectId,
  type ThreadId,
} from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import * as Schema from "effect/Schema";
import { useState } from "react";
import { randomUUID } from "../../lib/utils";
import { connectionAtomRuntime } from "../../connection/runtime";
import { useProject, useThreadShells } from "../../state/entities";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";

const automationCommand = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "project automation",
  tag: ORCHESTRATION_WS_METHODS.dispatchCommand,
});
const decodeDefinition = Schema.decodeOption(ProjectAutomationDefinition);
const days = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
type Props = { environmentId: EnvironmentId; projectId: ProjectId; rootThreadId?: ThreadId };

/** A project-scoped editor shared by project settings and the orchestrator Projects page. */
export function ProjectAutomationsPanel({ environmentId, projectId, rootThreadId }: Props) {
  const project = useProject(scopeProjectRef(environmentId, projectId));
  const threads = useThreadShells().filter(
    (thread) => thread.environmentId === environmentId && thread.projectId === projectId,
  );
  const dispatch = useAtomCommand(automationCommand);
  const [editing, setEditing] = useState<ProjectAutomationDefinition | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const automations = (project?.automations ?? []).filter(
    (automation) =>
      rootThreadId === undefined ||
      automation.ownerThreadId === rootThreadId ||
      (automation.target.kind === "existing-thread" &&
        automation.target.threadId === rootThreadId) ||
      (automation.ownerThreadId === undefined && automation.target.kind === "new-thread"),
  );
  const send = async (input: ClientOrchestrationCommand) => {
    setPending(true);
    setError(null);
    try {
      const result = await dispatch({ environmentId, input });
      if (result._tag === "Failure") {
        const failure = squashAtomCommandFailure(result);
        setError(failure instanceof Error ? failure.message : String(failure));
        return false;
      }
      return true;
    } finally {
      setPending(false);
    }
  };
  const act = (
    type:
      | "project.automation.pause"
      | "project.automation.resume"
      | "project.automation.delete"
      | "project.automation.run",
    automationId: string,
  ) => void send({ type, commandId: CommandId.make(randomUUID()), projectId, automationId });
  const save = async () => {
    if (!editing) return;
    const definition = decodeDefinition(editing);
    if (definition._tag === "None") {
      setError("Enter a name, prompt, valid time, and timezone.");
      return;
    }
    const exists = project?.automations?.some((automation) => automation.id === editing.id);
    if (
      await send({
        type: exists ? "project.automation.update" : "project.automation.create",
        commandId: CommandId.make(randomUUID()),
        projectId,
        automation: definition.value,
      })
    )
      setEditing(null);
  };
  return (
    <section aria-label="Automations" className="space-y-2">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-xs font-medium uppercase">Automations</h2>
        <Button
          variant="ghost"
          size="sm"
          disabled={pending}
          onClick={() =>
            setEditing({
              id: randomUUID(),
              name: "",
              prompt: "",
              enabled: true,
              schedule: {
                kind: "daily",
                time: "09:00",
                timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
              },
              target: rootThreadId
                ? { kind: "existing-thread", threadId: rootThreadId }
                : { kind: "new-thread" },
              ...(rootThreadId ? { ownerThreadId: rootThreadId } : {}),
            })
          }
        >
          Add
        </Button>
      </div>
      {automations.map((automation) => (
        <div key={automation.id} className="space-y-1">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
            <span className="font-medium">{automation.name}</span>
            <span>
              {automation.schedule.kind === "hourly"
                ? "Every hour"
                : automation.schedule.kind === "daily"
                  ? `Daily at ${automation.schedule.time}`
                  : `${days[automation.schedule.day]} at ${automation.schedule.time}`}{" "}
              ({automation.schedule.timeZone})
            </span>
            <span>
              {automation.enabled
                ? `Next ${new Date(automation.nextRunAt).toLocaleString()}`
                : "Paused"}
            </span>
            <span>
              {automation.target.kind === "new-thread"
                ? "New thread each run"
                : automation.target.threadId === rootThreadId
                  ? "Orchestrator"
                  : (threads.find(
                      (thread) =>
                        automation.target.kind === "existing-thread" &&
                        thread.id === automation.target.threadId,
                    )?.title ?? "Existing thread")}
            </span>
            <label className="flex items-center gap-1">
              <input
                aria-label={`Enable ${automation.name}`}
                type="checkbox"
                checked={automation.enabled}
                disabled={pending}
                onChange={() =>
                  act(
                    automation.enabled ? "project.automation.pause" : "project.automation.resume",
                    automation.id,
                  )
                }
              />
              Enabled
            </label>
            <Button
              variant="ghost"
              size="sm"
              disabled={pending}
              onClick={() => setEditing(automation)}
            >
              Edit
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={pending}
              onClick={() => act("project.automation.run", automation.id)}
            >
              Run now
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={pending}
              onClick={() => act("project.automation.delete", automation.id)}
            >
              Delete
            </Button>
          </div>
          {automation.runs.slice(0, 5).map((run) => (
            <div key={run.id} className="flex flex-wrap gap-x-3 text-xs">
              <time>{new Date(run.startedAt ?? run.scheduledAt).toLocaleString()}</time>
              <span>{run.status}</span>
              {threads.some((thread) => thread.id === run.threadId) ? (
                <Link
                  to="/$environmentId/$threadId"
                  params={{ environmentId, threadId: run.threadId }}
                >
                  Open thread
                </Link>
              ) : null}
              {run.result ? <span>{run.result}</span> : null}
            </div>
          ))}
        </div>
      ))}
      {editing ? (
        <form
          className="grid max-w-2xl gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <Input
            aria-label="Automation name"
            placeholder="Name"
            value={editing.name}
            onChange={(event) => setEditing({ ...editing, name: event.target.value })}
          />
          <Textarea
            aria-label="Automation prompt"
            placeholder="Prompt"
            value={editing.prompt}
            onChange={(event) => setEditing({ ...editing, prompt: event.target.value })}
          />
          <div className="flex flex-wrap items-center gap-2">
            <select
              aria-label="Schedule"
              value={editing.schedule.kind}
              onChange={(event) => {
                const kind = event.target.value;
                const timeZone = editing.schedule.timeZone;
                setEditing({
                  ...editing,
                  schedule:
                    kind === "hourly"
                      ? { kind, timeZone }
                      : kind === "weekly"
                        ? { kind, timeZone, time: "09:00", day: 1 }
                        : { kind: "daily", timeZone, time: "09:00" },
                });
              }}
            >
              <option value="daily">Daily</option>
              <option value="hourly">Hourly</option>
              <option value="weekly">Weekly</option>
            </select>
            {editing.schedule.kind !== "hourly" ? (
              <input
                aria-label="Run time"
                type="time"
                value={editing.schedule.time}
                onChange={(event) => {
                  if (editing.schedule.kind !== "hourly")
                    setEditing({
                      ...editing,
                      schedule: { ...editing.schedule, time: event.target.value },
                    });
                }}
              />
            ) : null}
            {editing.schedule.kind === "weekly" ? (
              <select
                aria-label="Day"
                value={editing.schedule.day}
                onChange={(event) => {
                  if (editing.schedule.kind === "weekly")
                    setEditing({
                      ...editing,
                      schedule: { ...editing.schedule, day: Number(event.target.value) },
                    });
                }}
              >
                {days.map((day, index) => (
                  <option key={day} value={index}>
                    {day}
                  </option>
                ))}
              </select>
            ) : null}
            <Input
              aria-label="Timezone"
              value={editing.schedule.timeZone}
              onChange={(event) =>
                setEditing({
                  ...editing,
                  schedule: { ...editing.schedule, timeZone: event.target.value },
                })
              }
            />
          </div>
          <select
            aria-label="Target thread"
            value={editing.target.kind === "new-thread" ? "new" : editing.target.threadId}
            onChange={(event) =>
              setEditing({
                ...editing,
                target:
                  event.target.value === "new"
                    ? { kind: "new-thread" }
                    : { kind: "existing-thread", threadId: event.target.value as ThreadId },
              })
            }
          >
            <option value="new">New thread each run</option>
            {threads.map((thread) => (
              <option key={thread.id} value={thread.id}>
                {thread.id === rootThreadId ? "Orchestrator" : thread.title}
              </option>
            ))}
          </select>
          <div className="flex gap-2">
            <Button size="sm" disabled={pending} type="submit">
              Save
            </Button>
            <Button variant="ghost" size="sm" type="button" onClick={() => setEditing(null)}>
              Cancel
            </Button>
          </div>
        </form>
      ) : null}
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </section>
  );
}
