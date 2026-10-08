import type { OrchestratorSummary } from "@t3tools/client-runtime/state/orchestrators";
import { ChevronDownIcon, ChevronRightIcon } from "lucide-react";
import { useMemo, useState } from "react";

import { useLocalStorage } from "../../hooks/useLocalStorage";
import { InlineButton } from "../ui/button";
import { groupOpen, NO_OPEN_KEYS, openKeysSchema, setGroupOpen } from "./openGroups.logic";
import { formatIssueAge } from "./projectIssuesBoard.logic";
import { deriveBlocked } from "./projectWork.logic";
import { isBug, issueKey, TASK_STATUS_LABEL, taskKind } from "./projectRequests.logic";
import {
  useOpenThread,
  useSettle,
  useTaskStatuses,
  type SettleControls,
} from "./ProjectRequestsSection";
import { RowMenu, StatusCell } from "./ProjectSection";
import { RequestKindTag } from "./RequestKindTag";
import { TaskTitle } from "./TaskLink";
import { taskStepProgress } from "./taskProgress.logic";
import {
  bandOpensByDefault,
  blockedNotes,
  deriveBands,
  type Band,
  type BandRow,
} from "./workstreamBands.logic";
import { deriveTeam, TEAM_TAG_LABEL, teamIds, type TeamMember } from "./workstreamTeam.logic";
import {
  DONE_PER_GROUP,
  deriveThreadView,
  THREAD_TAG_LABEL,
  type ThreadRow,
} from "./workstreamThreads.logic";

/** The project's tasks by workstream, from the same statuses the Tasks board uses. */
export function useWorkstreamBands(
  summary: OrchestratorSummary,
  { statuses, query }: ReturnType<typeof useTaskStatuses>,
  since: string | null = null,
) {
  const threadsById = useMemo(
    () => new Map([summary.root, ...summary.descendants].map((thread) => [thread.id, thread])),
    [summary.descendants, summary.root],
  );
  const now = query.dataUpdatedAt ?? 0;
  const blocked = useMemo(
    () =>
      blockedNotes(
        deriveBlocked({
          blockedWorkers: summary.blocked,
          issues: query.data?.issues ?? [],
          statuses,
          threads: [summary.root, ...summary.descendants],
          rootThreadId: summary.root.id,
          now,
        }),
      ),
    [now, query.data, statuses, summary.blocked, summary.descendants, summary.root],
  );
  const bands = useMemo(
    () =>
      deriveBands({
        issues: query.data?.issues ?? [],
        statuses,
        threadsById,
        rootThreadId: summary.root.id,
        since,
        taskNotes: blocked.tasks,
      }),
    [blocked.tasks, query.data, since, statuses, summary.root.id, threadsById],
  );
  const team = useMemo(
    () =>
      deriveTeam({
        root: summary.root,
        descendants: summary.descendants,
        bands,
        workerNotes: blocked.workers,
      }),
    [bands, blocked.workers, summary.descendants, summary.root],
  );
  const threads = useMemo(
    () =>
      deriveThreadView({
        bands,
        summary,
        workerNotes: blocked.workers,
        since,
        exclude: teamIds(summary.root, summary.descendants),
      }),
    [bands, blocked.workers, since, summary],
  );
  return { bands, threads, team, refresh: query.refresh, threadsById, now };
}

export type Workstreams = ReturnType<typeof useWorkstreamBands>;

const OTHER_THREADS_KEY = "other-threads";

function BandRowItem({
  row,
  now,
  settle,
  openThread,
  steps,
}: {
  readonly row: BandRow;
  readonly now: number;
  readonly settle: SettleControls;
  readonly openThread: (threadId: string) => void;
  readonly steps: string | null;
}) {
  const { issue, status } = row;
  const closed = status === "complete";
  const label = TASK_STATUS_LABEL[status];
  return (
    <li className="flex items-start gap-3 py-1.5">
      <StatusCell tone={status === "for-review" ? "strong" : "muted"}>{label}</StatusCell>
      <div className="min-w-0 flex-1">
        <TaskTitle
          task={{ host: issue.host, repository: issue.repository, number: issue.number }}
          url={issue.url}
          className="max-w-full text-sm text-foreground hover:underline"
        >
          {issue.title}
        </TaskTitle>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
          <span className="sm:hidden">{label}</span>
          <RequestKindTag kind={taskKind(issue.labels)} bug={isBug(issue.labels)} />
          <span className="tabular-nums">#{issue.number}</span>
          {row.blockedBy.length > 0 ? (
            <span className="text-error">
              blocked by {row.blockedBy.map((number) => `#${number}`).join(", ")}
            </span>
          ) : null}
          {row.blockedNote ? <span className="text-error">{row.blockedNote}</span> : null}
          {steps ? <span className="tabular-nums">{steps}</span> : null}
          {row.agents.map((agent) => (
            <InlineButton
              key={agent.threadId}
              tone="muted"
              onClick={() => openThread(agent.threadId)}
            >
              {agent.working ? "working" : "idle"} {agent.title}
            </InlineButton>
          ))}
          <span className="tabular-nums">
            {formatIssueAge(issue.closedAt ?? issue.updatedAt, now)}
          </span>
        </div>
        {row.latest ? <p className="mt-0.5 text-xs text-muted-foreground">{row.latest}</p> : null}
      </div>
      <RowMenu
        label={issue.title}
        items={[
          closed
            ? {
                label: "Reopen",
                disabled: settle.isBusy(issue),
                onClick: () => void settle.reopen(issue),
              }
            : {
                label: "Settle",
                disabled: settle.isBusy(issue),
                onClick: () => void settle.settle([issue]),
              },
        ]}
      />
    </li>
  );
}

const TAG_TONE = {
  waiting: "strong",
  error: "warning",
  blocked: "warning",
  running: "muted",
  done: "muted",
} as const;

/** One thread, or a task with none that needs Brad or is blocked, tagged by what it asks. */
function ThreadRowItem({
  row,
  now,
  openThread,
}: {
  readonly row: ThreadRow;
  readonly now: number;
  readonly openThread: (threadId: string) => void;
}) {
  const label = THREAD_TAG_LABEL[row.tag];
  const { issue, threadId } = row;
  return (
    <li className="flex items-start gap-3 py-1.5">
      <StatusCell tone={TAG_TONE[row.tag]}>{label}</StatusCell>
      <div className="min-w-0 flex-1">
        {threadId ? (
          <span className="text-sm">
            <InlineButton onClick={() => openThread(threadId)}>
              <span className="whitespace-normal text-left">{row.title}</span>
            </InlineButton>
          </span>
        ) : issue ? (
          <TaskTitle
            task={{ host: issue.host, repository: issue.repository, number: issue.number }}
            url={issue.url}
            className="max-w-full text-sm text-foreground hover:underline"
          >
            {row.title}
          </TaskTitle>
        ) : (
          <span className="text-sm">{row.title}</span>
        )}
        <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
          <span className="sm:hidden">{label}</span>
          {issue ? <span className="tabular-nums">#{issue.number}</span> : null}
          {row.note ? <span className="text-error">{row.note}</span> : null}
          {row.steps ? <span className="tabular-nums">{row.steps}</span> : null}
          <span className="tabular-nums">{formatIssueAge(row.at, now)}</span>
        </div>
        {row.latest ? <p className="mt-0.5 text-xs text-muted-foreground">{row.latest}</p> : null}
      </div>
    </li>
  );
}

/** A group's thread rows; finished ones beyond the first few fold behind a "Show" button. */
function ThreadRowList({
  rows,
  now,
  openThread,
}: {
  readonly rows: ReadonlyArray<ThreadRow>;
  readonly now: number;
  readonly openThread: (threadId: string) => void;
}) {
  const [showAll, setShowAll] = useState(false);
  const done = rows.filter((row) => row.tag === "done");
  const folded = Math.max(0, done.length - DONE_PER_GROUP);
  const hidden = new Set(showAll ? [] : done.slice(DONE_PER_GROUP));
  return (
    <>
      <ul className="divide-y divide-border">
        {rows
          .filter((row) => !hidden.has(row))
          .map((row) => (
            <ThreadRowItem key={row.key} row={row} now={now} openThread={openThread} />
          ))}
      </ul>
      {folded > 0 ? (
        <p className="text-xs">
          <InlineButton tone="muted" onClick={() => setShowAll((value) => !value)}>
            {showAll ? "Show fewer done" : `Show ${folded} more done`}
          </InlineButton>
        </p>
      ) : null}
    </>
  );
}

const TEAM_TONE = {
  waiting: "strong",
  error: "warning",
  blocked: "warning",
  running: "muted",
  idle: "muted",
} as const;

/**
 * The Team strip: the project's head and its standing sub-agents, each with its
 * responsibility, a status tag ("idle" between turns), what it owns and Open.
 */
export function TeamStrip({
  summary,
  team,
  now,
}: {
  readonly summary: OrchestratorSummary;
  readonly team: ReadonlyArray<TeamMember>;
  readonly now: number;
}) {
  const openThread = useOpenThread(summary);
  return (
    <ul className="divide-y divide-border">
      {team.map((member) => {
        const label = TEAM_TAG_LABEL[member.tag];
        return (
          <li key={member.threadId} className="flex items-start gap-3 py-1.5">
            <StatusCell tone={TEAM_TONE[member.tag]}>{label}</StatusCell>
            <div className="min-w-0 flex-1">
              <span className="text-sm">
                <InlineButton onClick={() => openThread(member.threadId)}>
                  <span className="whitespace-normal text-left">{member.title}</span>
                </InlineButton>
              </span>
              <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
                <span className="sm:hidden">{label}</span>
                {member.head ? <span>head</span> : null}
                {member.owns ? <span className="tabular-nums">{member.owns}</span> : null}
                <span className="tabular-nums">{formatIssueAge(member.at, now)}</span>
              </div>
              {member.responsibility ? (
                <p className="mt-0.5 text-xs text-muted-foreground">{member.responsibility}</p>
              ) : null}
              {member.latest ? (
                <p className="mt-0.5 text-xs text-muted-foreground">last said: {member.latest}</p>
              ) : null}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * Workstream bands: each open epic with its tasks as rows (For review, Active,
 * Pending, Complete folded), then the tasks that belong to no epic. The Tasks tab
 * and the Dashboard's Workstreams block are this one component; `compact` is the
 * Dashboard's: thread rows instead of task rows, no Complete fold, no epic menu.
 * Open or closed choices are remembered per project on this device.
 */
export function WorkstreamBands({
  summary,
  workstreams,
  bands = workstreams.bands,
  compact = false,
}: {
  readonly summary: OrchestratorSummary;
  readonly workstreams: Workstreams;
  /** The bands to list, when not all of them. */
  readonly bands?: ReadonlyArray<Band>;
  readonly compact?: boolean;
}) {
  const { threadsById, now } = workstreams;
  const settle = useSettle(summary, workstreams.refresh);
  const openThread = useOpenThread(summary);
  // Choices the user made, per band and Complete fold; anything unchosen follows its default.
  const [chosen, setChosen] = useLocalStorage(
    `t3code:projects:bands-open:${summary.root.environmentId}:${summary.root.id}`,
    NO_OPEN_KEYS,
    openKeysSchema,
  );
  const setOpen = (key: string, open: boolean) =>
    setChosen((current) => setGroupOpen(current, key, open));
  // Sub-agents outside any workstream open when one of them needs a look, unless the user chose.
  const otherOpen = groupOpen(
    chosen,
    OTHER_THREADS_KEY,
    workstreams.threads.other.some((row) => row.tag !== "done"),
  );
  return (
    <div className="flex flex-col gap-3">
      {bands.map((band) => {
        const open = groupOpen(chosen, band.key, bandOpensByDefault(band, bands.length));
        const completeKey = `${band.key}:complete`;
        const completeOpen = groupOpen(chosen, completeKey, false);
        const title = band.epic?.title ?? "Other tasks";
        const count = band.rows.length + (compact ? 0 : band.complete.length);
        return (
          <section key={band.key}>
            <h3 className="flex flex-wrap items-baseline gap-x-2 text-sm">
              <InlineButton aria-expanded={open} onClick={() => setOpen(band.key, !open)}>
                {open ? (
                  <ChevronDownIcon className="size-3.5" />
                ) : (
                  <ChevronRightIcon className="size-3.5" />
                )}
                <span className="whitespace-normal text-left">{title}</span>
              </InlineButton>
              {band.epic ? (
                <TaskTitle
                  task={{
                    host: band.epic.host,
                    repository: band.epic.repository,
                    number: band.epic.number,
                  }}
                  url={band.epic.url}
                  className="text-xs text-muted-foreground tabular-nums hover:underline"
                >
                  #{band.epic.number}
                </TaskTitle>
              ) : null}
              <span className="text-xs text-muted-foreground tabular-nums">
                {band.milestone ? `${band.milestone} · ` : ""}
                {band.progress ?? count}
              </span>
              {band.needsYou > 0 ? (
                <span className="text-xs text-foreground">{band.needsYou} need you</span>
              ) : null}
              {band.agentsWorking > 0 ? (
                <span className="text-xs text-muted-foreground">
                  {band.agentsWorking} {band.agentsWorking === 1 ? "agent" : "agents"}
                </span>
              ) : null}
              {band.blocked > 0 ? (
                <span className="text-xs text-error">{band.blocked} blocked</span>
              ) : null}
              {!compact && band.epic ? (
                <span className="ml-auto">
                  <RowMenu
                    label={band.epic.title}
                    items={[
                      {
                        label: "Settle",
                        disabled: settle.isBusy(band.epic),
                        onClick: () => void settle.settle([band.epic!]),
                      },
                    ]}
                  />
                </span>
              ) : null}
            </h3>
            {open ? (
              <>
                {band.changes ? (
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    Since you looked: {band.changes}
                  </p>
                ) : null}
                {compact ? (
                  <ThreadRowList
                    rows={workstreams.threads.byBand.get(band.key) ?? []}
                    now={now}
                    openThread={openThread}
                  />
                ) : (
                  <ul className="divide-y divide-border">
                    {band.rows.map((row) => (
                      <BandRowItem
                        key={issueKey(row.issue)}
                        row={row}
                        now={now}
                        settle={settle}
                        openThread={openThread}
                        steps={
                          row.status === "active" ? taskStepProgress(row.issue, threadsById) : null
                        }
                      />
                    ))}
                  </ul>
                )}
                {!compact && band.complete.length > 0 ? (
                  <div className="mt-1">
                    <p className="text-xs">
                      <InlineButton
                        tone="muted"
                        aria-expanded={completeOpen}
                        onClick={() => setOpen(completeKey, !completeOpen)}
                      >
                        Complete {band.complete.length}
                      </InlineButton>
                    </p>
                    {completeOpen ? (
                      <ul className="divide-y divide-border">
                        {band.complete.map((row) => (
                          <BandRowItem
                            key={issueKey(row.issue)}
                            row={row}
                            now={now}
                            settle={settle}
                            openThread={openThread}
                            steps={null}
                          />
                        ))}
                      </ul>
                    ) : null}
                  </div>
                ) : null}
              </>
            ) : null}
          </section>
        );
      })}
      {compact && workstreams.threads.other.length > 0 ? (
        <section>
          <h3 className="flex flex-wrap items-baseline gap-x-2 text-sm">
            <InlineButton
              aria-expanded={otherOpen}
              onClick={() => setOpen(OTHER_THREADS_KEY, !otherOpen)}
            >
              {otherOpen ? (
                <ChevronDownIcon className="size-3.5" />
              ) : (
                <ChevronRightIcon className="size-3.5" />
              )}
              Other threads
            </InlineButton>
            <span className="text-xs text-muted-foreground tabular-nums">
              {workstreams.threads.other.length}
            </span>
          </h3>
          {otherOpen ? (
            <ThreadRowList rows={workstreams.threads.other} now={now} openThread={openThread} />
          ) : null}
        </section>
      ) : null}
    </div>
  );
}
