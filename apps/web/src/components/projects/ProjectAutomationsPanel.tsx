import {
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import {
  AutomationDefinition,
  type EnvironmentId,
  type ProjectId,
  type ThreadId,
} from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import * as Schema from "effect/Schema";
import { useState } from "react";
import { randomUUID } from "../../lib/utils";
import {
  automationRunsQuery,
  automationsQuery,
  removeAutomation,
  runAutomation,
  saveAutomation,
  setAutomationEnabled,
} from "../../state/automations";
import { useThreadShells } from "../../state/entities";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import {
  automationSummary,
  belongsToRoot,
  DAY_NAMES,
  fromDraft,
  toDraft,
  type AutomationDraft,
} from "./projectAutomations.logic";

const decodeDefinition = Schema.decodeOption(AutomationDefinition);
type Props = { environmentId: EnvironmentId; projectId: ProjectId; rootThreadId?: ThreadId };

/** A project-scoped editor shared by project settings and the orchestrator Projects page. */
export function ProjectAutomationsPanel({ environmentId, projectId, rootThreadId }: Props) {
  const threads = useThreadShells().filter(
    (thread) => thread.environmentId === environmentId && thread.projectId === projectId,
  );
  const list = useEnvironmentQuery(automationsQuery({ environmentId, input: { projectId } }));
  const runLog = useEnvironmentQuery(
    automationRunsQuery({ environmentId, input: { projectId, limit: 100 } }),
  );
  const save = useAtomCommand(saveAutomation, "Save automation");
  const remove = useAtomCommand(removeAutomation, "Delete automation");
  const toggle = useAtomCommand(setAutomationEnabled, "Pause or resume automation");
  const run = useAtomCommand(runAutomation, "Run automation");
  const [editing, setEditing] = useState<AutomationDraft | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const automations = (list.data?.automations ?? []).filter((automation) =>
    belongsToRoot(automation, rootThreadId),
  );
  const runs = runLog.data?.runs ?? [];
  const send = async (request: () => Promise<AtomCommandResult<unknown, unknown>>) => {
    setPending(true);
    setError(null);
    try {
      const result = await request();
      if (result._tag === "Failure") {
        const failure = squashAtomCommandFailure(result);
        setError(failure instanceof Error ? failure.message : String(failure));
        return false;
      }
      list.refresh();
      runLog.refresh();
      return true;
    } finally {
      setPending(false);
    }
  };
  const onSave = async () => {
    if (!editing) return;
    const definition = decodeDefinition(fromDraft(editing, projectId));
    if (definition._tag === "None") {
      setError("Enter a name, prompt, valid time, days, and timezone.");
      return;
    }
    if (await send(() => save({ environmentId, input: definition.value }))) setEditing(null);
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
      {automations.map((automation) => {
        const draft = toDraft(automation);
        const first = automation.triggers[0];
        const timeZone = first?.type === "schedule" ? first.schedule.timeZone : undefined;
        const target = automation.actions[0]?.target;
        return (
          <div key={automation.id} className="space-y-1">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
              <span className="font-medium">{automation.name}</span>
              <span>
                {automationSummary(automation)}
                {timeZone ? ` (${timeZone})` : ""}
              </span>
              <span>
                {!automation.enabled
                  ? "Paused"
                  : automation.nextRunAt
                    ? `Next ${new Date(automation.nextRunAt).toLocaleString()}`
                    : null}
              </span>
              <span>
                {target === undefined || target.kind === "new-thread"
                  ? "New thread each run"
                  : target.threadId === rootThreadId
                    ? "Orchestrator"
                    : (threads.find((thread) => thread.id === target.threadId)?.title ??
                      "Existing thread")}
              </span>
              <label className="flex items-center gap-1">
                <input
                  aria-label={`Enable ${automation.name}`}
                  type="checkbox"
                  checked={automation.enabled}
                  disabled={pending}
                  onChange={() =>
                    void send(() =>
                      toggle({
                        environmentId,
                        input: { automationId: automation.id, enabled: !automation.enabled },
                      }),
                    )
                  }
                />
                Enabled
              </label>
              <Button
                variant="ghost"
                size="sm"
                disabled={pending || draft === null}
                title={draft === null ? "Edit this rule with t3-thread automation" : undefined}
                onClick={() => setEditing(draft)}
              >
                Edit
              </Button>
              <Button
                variant="ghost"
                size="sm"
                disabled={pending}
                onClick={() =>
                  void send(() => run({ environmentId, input: { automationId: automation.id } }))
                }
              >
                Run now
              </Button>
              <Button
                variant="ghost"
                size="sm"
                disabled={pending}
                onClick={() =>
                  void send(() => remove({ environmentId, input: { automationId: automation.id } }))
                }
              >
                Delete
              </Button>
            </div>
            {runs
              .filter((entry) => entry.automationId === automation.id)
              .slice(0, 5)
              .map((entry) => {
                const threadId = entry.steps[0]?.threadId;
                return (
                  <div key={entry.id} className="flex flex-wrap gap-x-3 text-xs">
                    <time>
                      {new Date(entry.steps[0]?.startedAt ?? entry.createdAt).toLocaleString()}
                    </time>
                    <span>{entry.dryRun ? `dry run` : entry.status}</span>
                    {threadId && threads.some((thread) => thread.id === threadId) ? (
                      <Link to="/$environmentId/$threadId" params={{ environmentId, threadId }}>
                        Open thread
                      </Link>
                    ) : null}
                    {entry.result ? <span>{entry.result}</span> : null}
                  </div>
                );
              })}
          </div>
        );
      })}
      {editing ? (
        <form
          className="grid max-w-2xl gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            void onSave();
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
                const time = "time" in editing.schedule ? editing.schedule.time : "09:00";
                setEditing({
                  ...editing,
                  schedule:
                    kind === "hourly"
                      ? { kind, timeZone }
                      : kind === "weekly"
                        ? { kind, timeZone, time, day: 1 }
                        : kind === "weekdays"
                          ? { kind, timeZone, time, days: [1, 2, 3, 4, 5] }
                          : { kind: "daily", timeZone, time },
                });
              }}
            >
              <option value="daily">Daily</option>
              <option value="weekdays">Selected days</option>
              <option value="hourly">Hourly</option>
              <option value="weekly">Weekly</option>
              {editing.schedule.kind === "cron" ? <option value="cron">Cron</option> : null}
            </select>
            {"time" in editing.schedule ? (
              <input
                aria-label="Run time"
                type="time"
                value={editing.schedule.time}
                onChange={(event) => {
                  if ("time" in editing.schedule)
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
                {DAY_NAMES.map((day, index) => (
                  <option key={day} value={index}>
                    {day}
                  </option>
                ))}
              </select>
            ) : null}
            {editing.schedule.kind === "weekdays"
              ? DAY_NAMES.map((day, index) => {
                  const schedule = editing.schedule;
                  if (schedule.kind !== "weekdays") return null;
                  return (
                    <label key={day} className="flex items-center gap-1 text-sm">
                      <input
                        type="checkbox"
                        checked={schedule.days.includes(index)}
                        onChange={(event) =>
                          setEditing({
                            ...editing,
                            schedule: {
                              ...schedule,
                              days: event.target.checked
                                ? [...schedule.days, index]
                                : schedule.days.filter((entry) => entry !== index),
                            },
                          })
                        }
                      />
                      {day.slice(0, 3)}
                    </label>
                  );
                })
              : null}
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
      {(error ?? list.error) ? (
        <p role="alert" className="text-sm text-destructive">
          {error ?? list.error}
        </p>
      ) : null}
    </section>
  );
}
