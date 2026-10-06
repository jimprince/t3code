import {
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import {
  AutomationDefinition,
  type Automation,
  type AutomationResultMode,
  type EnvironmentId,
  type ProjectId,
  type ThreadId,
} from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { MoreHorizontalIcon } from "lucide-react";
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
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "../ui/menu";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";
import {
  belongsToRoot,
  DAY_NAMES,
  fromDraft,
  ruleLine,
  toDraft,
  type AutomationDraft,
} from "./projectAutomations.logic";

const decodeDefinition = Schema.decodeOption(AutomationDefinition);

/** What a rule does with its agent's result; unset sends the prompt as written. */
const RESULT_MODES = {
  unset: "Unset (send the prompt as written)",
  review: "Review (file nothing, thread stays open)",
  "file-only": "File only",
  "file-and-settle": "File and settle",
  act: "Act (no filing or settling instructions)",
} as const;
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
  const [deleting, setDeleting] = useState<Automation | null>(null);
  const [showingRuns, setShowingRuns] = useState<ReadonlySet<string>>(() => new Set());
  // Relative times use the newest refresh (every 15-30 s while open); rules render only once
  // the list has loaded, so a timestamp is always present.
  const now = Math.max(list.dataUpdatedAt ?? 0, runLog.dataUpdatedAt ?? 0);
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
        const target = automation.actions[0]?.target;
        const ruleRuns = runs.filter((entry) => entry.automationId === automation.id);
        const line = ruleLine({
          automation,
          now,
          target:
            target === undefined || target.kind === "new-thread"
              ? "new thread"
              : target.threadId === rootThreadId
                ? "orchestrator"
                : (threads.find((thread) => thread.id === target.threadId)?.title ??
                  "existing thread"),
          lastRun: ruleRuns[0],
        });
        const lastThreadId = ruleRuns[0]?.steps[0]?.threadId;
        const expanded = showingRuns.has(automation.id);
        return (
          <div key={automation.id} className="space-y-1">
            <div className="flex items-center gap-3">
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium">{automation.name}</div>
                <div className="truncate text-xs text-muted-foreground">
                  {line.summary}
                  {line.last ? " · " : null}
                  {line.last &&
                  lastThreadId &&
                  threads.some((thread) => thread.id === lastThreadId) ? (
                    <Link
                      to="/$environmentId/$threadId"
                      params={{ environmentId, threadId: lastThreadId }}
                    >
                      {line.last}
                    </Link>
                  ) : (
                    line.last
                  )}
                </div>
              </div>
              <Switch
                size="sm"
                aria-label={`Enable ${automation.name}`}
                checked={automation.enabled}
                disabled={pending}
                onCheckedChange={(enabled) =>
                  void send(() =>
                    toggle({ environmentId, input: { automationId: automation.id, enabled } }),
                  )
                }
              />
              <Menu>
                <MenuTrigger
                  render={
                    <Button
                      size="icon-xs"
                      variant="ghost"
                      aria-label={`Actions for ${automation.name}`}
                      disabled={pending}
                    />
                  }
                >
                  <MoreHorizontalIcon />
                </MenuTrigger>
                <MenuPopup align="end">
                  <MenuItem
                    disabled={draft === null}
                    title={draft === null ? "Edit this rule with t3-thread automation" : undefined}
                    onClick={() => setEditing(draft)}
                  >
                    Edit
                  </MenuItem>
                  <MenuItem
                    onClick={() =>
                      void send(() =>
                        run({ environmentId, input: { automationId: automation.id } }),
                      )
                    }
                  >
                    Run now
                  </MenuItem>
                  <MenuItem
                    disabled={ruleRuns.length === 0}
                    onClick={() =>
                      setShowingRuns((current) => {
                        const next = new Set(current);
                        if (!next.delete(automation.id)) next.add(automation.id);
                        return next;
                      })
                    }
                  >
                    {expanded ? "Hide recent runs" : "Recent runs"}
                  </MenuItem>
                  <MenuSeparator />
                  <MenuItem variant="destructive" onClick={() => setDeleting(automation)}>
                    Delete
                  </MenuItem>
                </MenuPopup>
              </Menu>
            </div>
            {expanded
              ? ruleRuns.slice(0, 5).map((entry) => {
                  const threadId = entry.steps[0]?.threadId;
                  return (
                    <div
                      key={entry.id}
                      className="flex flex-wrap gap-x-3 text-xs text-muted-foreground"
                    >
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
                })
              : null}
          </div>
        );
      })}
      <AlertDialog
        open={deleting !== null}
        onOpenChange={(open) => {
          if (!open && !pending) setDeleting(null);
        }}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {deleting?.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              It stops running. Runs that have not started are skipped; past runs and their threads
              stay.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose disabled={pending} render={<Button variant="outline" />}>
              Cancel
            </AlertDialogClose>
            <Button
              variant="destructive"
              disabled={pending}
              onClick={() => {
                if (!deleting) return;
                const automationId = deleting.id;
                void send(() => remove({ environmentId, input: { automationId } })).then((ok) => {
                  if (ok) setDeleting(null);
                });
              }}
            >
              Delete
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
      {editing ? (
        <form
          className="grid max-w-2xl grid-cols-[minmax(0,1fr)] gap-2"
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
          <Select
            value={editing.resultMode ?? "unset"}
            items={RESULT_MODES}
            onValueChange={(next) => {
              const { resultMode: _ignored, ...rest } = editing;
              setEditing(
                next === null || next === "unset"
                  ? rest
                  : { ...rest, resultMode: next as AutomationResultMode },
              );
            }}
          >
            <SelectTrigger aria-label="Result mode">
              <SelectValue />
            </SelectTrigger>
            <SelectPopup>
              {Object.entries(RESULT_MODES).map(([mode, label]) => (
                <SelectItem key={mode} value={mode}>
                  {label}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
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
