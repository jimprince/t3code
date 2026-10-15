import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  describeSubheadModel,
  describeSubheadRun,
  describeSubheadWorkspace,
  isOpenSubheadRun,
  queuePositions,
  RUNTIME_MODE_LABEL,
  SUBHEAD_FIXED_LIMITS,
  subheadState,
  type SubheadTone,
} from "@t3tools/client-runtime/state/subheads-view";
import type { EnvironmentId, Subhead, SubheadRunRow, ThreadId } from "@t3tools/contracts";
import { formatLocalWhen } from "@t3tools/shared/localTime";
import { useNavigate } from "@tanstack/react-router";
import { ChevronLeftIcon } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";

import { isElectron } from "../../env";
import { useNowMinute } from "../../hooks/useNowMinute";
import { cn } from "../../lib/utils";
import { useProjects, useThreadShells } from "../../state/entities";
import { useSubheadPage } from "../../state/subheads";
import { buildThreadRouteParams } from "../../threadRoutes";
import { useSidebarMode } from "../sidebarMode";
import { Button } from "../ui/button";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { SidebarInset, useSidebar } from "../ui/sidebar";
import { WorkspacePageContainer } from "../WorkspacePageContainer";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { SubheadEditForm } from "./SubheadEditForm";
import { SubheadSendDialog } from "./SubheadSendDialog";
import { useSubheadCall } from "./useSubheadCommand";

const TONE_TEXT: Record<SubheadTone, string> = {
  ok: "text-success-foreground",
  error: "text-error",
  warning: "text-warning-foreground",
  info: "text-info-foreground",
  muted: "text-muted-foreground",
};

type HistoryFilter = "all" | "failed" | "undelivered";
const FILTERS: ReadonlyArray<{ readonly id: HistoryFilter; readonly label: string }> = [
  { id: "all", label: "All" },
  { id: "failed", label: "Failed" },
  { id: "undelivered", label: "Undelivered" },
];

function Section({
  title,
  detail,
  children,
}: {
  readonly title: string;
  readonly detail?: string | null;
  readonly children: ReactNode;
}) {
  return (
    <section className="flex min-w-0 flex-col gap-1.5">
      <div className="flex items-baseline gap-2">
        <h2 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
          {title}
        </h2>
        {detail ? <span className="ml-auto text-xs text-muted-foreground">{detail}</span> : null}
      </div>
      {children}
    </section>
  );
}

/** One run: stacked on a phone, one row of columns from `sm` up. */
function RunRow({
  environmentId,
  subhead,
  run,
  queuePosition,
  now,
  senderTitle,
  threadExists,
}: {
  readonly environmentId: EnvironmentId;
  readonly subhead: Subhead;
  readonly run: SubheadRunRow;
  readonly queuePosition: number | null;
  readonly now: number;
  readonly senderTitle: (threadId: ThreadId) => string | null;
  readonly threadExists: (threadId: ThreadId) => boolean;
}) {
  const navigate = useNavigate();
  const call = useSubheadCall(environmentId);
  const view = describeSubheadRun(run, {
    concurrency: subhead.concurrency,
    queuePosition,
    senderTitle,
  });
  const [result, setResult] = useState<
    { readonly text: string; readonly error: boolean } | null
  >(null);
  const hasThread = run.status !== "queued" && run.threadId !== null && threadExists(run.threadId);
  // The sender's own result: another sender's run is refused by the server, shown as it says.
  const readResult = async () => {
    const answer = await call({ operation: "result", runId: run.runId });
    if (!answer.ok) return setResult({ text: answer.message, error: true });
    const value = answer.value as { result?: string | null };
    setResult({ text: value.result ?? "No result recorded yet.", error: false });
  };
  return (
    <li className="flex flex-col gap-1 border-t border-border/60 py-2 text-sm @3xl/runs:grid @3xl/runs:grid-cols-[4.5rem_8rem_minmax(0,1fr)_9rem_12rem_6.5rem] @3xl/runs:items-start @3xl/runs:gap-x-3 @3xl/runs:gap-y-0">
      <span className="tabular-nums text-muted-foreground">
        {formatLocalWhen(Date.parse(run.createdAt), now)}
      </span>
      <span className="min-w-0 break-words">{view.sender}</span>
      <span className="min-w-0 break-words">
        {run.requestSummary}
        <span className="block text-xs text-muted-foreground">
          pinned v{run.templateVersion} · {run.requestId}
        </span>
      </span>
      <span className={cn("min-w-0 break-words", TONE_TEXT[view.outcome.tone])}>
        {view.outcome.text}
      </span>
      <span className={cn("min-w-0 break-words", TONE_TEXT[view.delivery.tone])}>
        {view.delivery.text}
        {view.receipt !== null ? (
          <span className="text-muted-foreground"> · receipt {view.receipt}</span>
        ) : null}
      </span>
      <span className="flex items-center gap-3 @3xl/runs:justify-end">
        {hasThread ? (
          <Button
            size="xs"
            variant="link"
            aria-label={`Open run thread of ${run.requestId}`}
            onClick={() =>
              void navigate({
                to: "/$environmentId/$threadId",
                params: buildThreadRouteParams(
                  scopeThreadRef(environmentId, run.threadId as ThreadId),
                ),
              })
            }
          >
            Open
          </Button>
        ) : (
          <span className="text-muted-foreground">
            {run.status === "queued" ? "no thread yet" : "none"}
          </span>
        )}
        {run.status === "completed" ? (
          <Button
            size="xs"
            variant="link"
            aria-label={`Read result of ${run.requestId}`}
            onClick={() => void readResult()}
          >
            Result
          </Button>
        ) : null}
      </span>
      {result !== null ? (
        <p
          className={cn(
            "col-span-full max-h-48 overflow-y-auto whitespace-pre-wrap break-words rounded-md bg-muted/40 p-2 text-xs",
            result.error && "text-error",
          )}
        >
          {result.text}
        </p>
      ) : null}
    </li>
  );
}

function RunHeader() {
  return (
    <div
      aria-hidden
      className="hidden gap-x-3 pb-1 text-xs text-muted-foreground @3xl/runs:grid @3xl/runs:grid-cols-[4.5rem_8rem_minmax(0,1fr)_9rem_12rem_6.5rem]"
    >
      <span>Time</span>
      <span>Sender</span>
      <span>Request</span>
      <span>Outcome</span>
      <span>Delivery</span>
      <span className="text-right">Run thread</span>
    </div>
  );
}

function Template({
  subhead,
  projectTitle,
  ownerTitle,
}: {
  readonly subhead: Subhead;
  readonly projectTitle: string;
  readonly ownerTitle: string;
}) {
  const limits = SUBHEAD_FIXED_LIMITS;
  const rows: ReadonlyArray<readonly [string, string]> = [
    ["Model", describeSubheadModel(subhead.modelSelection)],
    ["Project", projectTitle],
    ["Workspace", describeSubheadWorkspace(subhead.workspaceStrategy)],
    ["Runtime mode", RUNTIME_MODE_LABEL[subhead.runtimeMode]],
    [
      "Caps",
      `${subhead.concurrency} at a time · ${limits.queued} queued · ${limits.runsPerDay} runs/day · ${limits.senderRequests} per sender per ${limits.senderWindowMinutes} min · ${limits.timeoutMinutes} min timeout`,
    ],
    ["Owning head", ownerTitle],
    [
      "Who may edit",
      `${subhead.createdBy ?? "system"} (the creating principal) · name, project and head are fixed`,
    ],
  ];
  return (
    <Section title={`Template v${subhead.version}`}>
      <p className="max-h-40 overflow-y-auto whitespace-pre-wrap break-words text-sm">
        {subhead.prompt}
      </p>
      <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-4 gap-y-1 text-sm @3xl/runs:grid-cols-[max-content_minmax(0,1fr)_max-content_minmax(0,1fr)]">
        {rows.map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="min-w-0 break-words">{value}</dd>
          </div>
        ))}
      </dl>
    </Section>
  );
}

/**
 * One subhead in the main pane: its template, open runs, run history with sender, pinned version,
 * outcome, delivery and a link to each run thread, and the actions Send, Edit, Disable or Enable,
 * and Retire. The server's refusals are shown as written.
 */
export function SubheadPage({
  environmentId,
  name,
}: {
  readonly environmentId: EnvironmentId;
  readonly name: string;
}) {
  const page = useSubheadPage(environmentId, name);
  const call = useSubheadCall(environmentId);
  const nowMinute = useNowMinute();
  const now = useMemo(() => Date.parse(`${nowMinute}:00Z`), [nowMinute]);
  const threads = useThreadShells();
  const projects = useProjects();
  const navigate = useNavigate();
  const [, setSidebarMode] = useSidebarMode();
  const { isMobile, open, setOpen, setOpenMobile } = useSidebar();
  const [editing, setEditing] = useState(false);
  const [sending, setSending] = useState(false);
  const [retiring, setRetiring] = useState(false);
  const [filter, setFilter] = useState<HistoryFilter>("all");
  const [actionError, setActionError] = useState<string | null>(null);
  const { subhead, runs } = page;

  const threadTitles = useMemo(
    () =>
      new Map(
        threads
          .filter((thread) => thread.environmentId === environmentId)
          .map((thread) => [thread.id as string, thread.title]),
      ),
    [environmentId, threads],
  );
  const senderTitle = (id: ThreadId) => threadTitles.get(id) ?? null;
  const threadExists = (id: ThreadId) => threadTitles.has(id);
  const projectTitle =
    projects.find(
      (project) => project.environmentId === environmentId && project.id === subhead?.projectId,
    )?.title ??
    subhead?.projectId ??
    "";
  const ownerTitle = subhead
    ? (threadTitles.get(subhead.ownerThreadId) ?? subhead.ownerThreadId)
    : "";
  const showList = () => {
    setSidebarMode("harness");
    if (isMobile) setOpenMobile(true);
    else if (!open) setOpen(true);
  };
  const positions = useMemo(() => queuePositions(runs), [runs]);
  const openRuns = runs.filter(isOpenSubheadRun);
  const finished = runs.filter((run) => !isOpenSubheadRun(run));
  const shown = finished.filter((run) =>
    filter === "failed"
      ? run.status === "failed"
      : filter === "undelivered"
        ? run.delivery.status === "undelivered"
        : true,
  );
  const state = subhead ? subheadState(subhead) : null;

  const changeState = async (next: "enable" | "disable" | "retire") => {
    if (!subhead) return;
    setActionError(null);
    const result = await call({ operation: "state", name: subhead.name, state: next });
    if (!result.ok) setActionError(result.message);
    page.refresh();
  };
  const runRow = (run: SubheadRunRow) => (
    <RunRow
      key={run.runId}
      environmentId={environmentId}
      subhead={subhead as Subhead}
      run={run}
      queuePosition={positions.get(run.runId) ?? null}
      now={now}
      senderTitle={senderTitle}
      threadExists={threadExists}
    />
  );

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden">
      <div className="flex min-h-0 flex-1 flex-col">
        <WorkspacePageHeader electron={isElectron} className="bg-background">
          <Button
            size="xs"
            variant="ghost-muted"
            aria-label="Back to the Harness list"
            onClick={showList}
          >
            <ChevronLeftIcon aria-hidden />
            Harness
          </Button>
          <h1 className="min-w-0 flex-1 truncate text-sm font-medium">{subhead?.name ?? name}</h1>
          <button
            type="button"
            aria-label="Read the subhead again"
            className="shrink-0 cursor-pointer text-xs text-muted-foreground hover:underline"
            onClick={page.refresh}
          >
            refresh
          </button>
        </WorkspacePageHeader>
        <div className="topbar-scroll-fade min-h-0 min-w-0 flex-1 overflow-y-auto border-t border-border">
          <WorkspacePageContainer width="wide" className="gap-5">
            {subhead === null ? (
              page.error !== null ? (
                <div role="alert" className="flex items-start gap-2 text-sm text-muted-foreground">
                  <p className="min-w-0 flex-1 break-words">{page.error}</p>
                  <Button size="xs" variant="outline" onClick={page.refresh}>
                    Retry
                  </Button>
                </div>
              ) : page.loading ? (
                <p role="status" className="text-sm text-muted-foreground">
                  Loading the subhead...
                </p>
              ) : (
                <div className="flex flex-col items-start gap-2 text-sm text-muted-foreground">
                  <p>No subhead named {name} on this server.</p>
                  <Button size="xs" variant="outline" onClick={showList}>
                    Back to Harness
                  </Button>
                </div>
              )
            ) : (
              <>
                <div className="flex flex-col gap-1">
                  <p className="text-xs text-muted-foreground">
                    Harness › {ownerTitle} ›
                  </p>
                  <div className="flex flex-wrap items-start gap-2">
                    <h2 className="min-w-0 flex-1 text-lg font-semibold break-words">
                      {subhead.name}
                    </h2>
                    {editing ? null : (
                      <div className="flex flex-wrap gap-2">
                        <Button
                          size="sm"
                          disabled={state !== "enabled"}
                          onClick={() => setSending(true)}
                        >
                          Send
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={state === "retired"}
                          onClick={() => setEditing(true)}
                        >
                          Edit
                        </Button>
                        {state === "enabled" ? (
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => void changeState("disable")}
                          >
                            Disable
                          </Button>
                        ) : state === "disabled" ? (
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => void changeState("enable")}
                          >
                            Enable
                          </Button>
                        ) : null}
                        {state !== "retired" ? (
                          <Button
                            size="sm"
                            variant="destructive-outline"
                            onClick={() => setRetiring(true)}
                          >
                            Retire
                          </Button>
                        ) : null}
                      </div>
                    )}
                  </div>
                  <p className="text-sm break-words">
                    <span
                      className={
                        state === "enabled"
                          ? "text-success-foreground"
                          : state === "retired"
                            ? "text-error"
                            : "text-muted-foreground"
                      }
                    >
                      {state}
                    </span>
                    <span className="text-muted-foreground">
                      {" "}
                      · template, no live session · v{subhead.version} · {ownerTitle} ·{" "}
                      {describeSubheadModel(subhead.modelSelection)} · {projectTitle}
                    </span>
                  </p>
                  {subhead.description ? (
                    <p className="text-sm break-words text-muted-foreground">
                      {subhead.description}
                    </p>
                  ) : null}
                  {actionError !== null ? (
                    <p role="alert" className="text-sm break-words text-error">
                      {actionError}
                    </p>
                  ) : null}
                  {page.error !== null ? (
                    <p role="alert" className="text-sm break-words text-warning-foreground">
                      The server did not answer ({page.error}); showing the last read.
                    </p>
                  ) : null}
                  {state === "retired" ? (
                    <p className="text-sm text-muted-foreground">
                      Retired: it takes no new requests, its name stays reserved and its history
                      stays here.
                    </p>
                  ) : state === "disabled" && openRuns.some((run) => run.status === "queued") ? (
                    <p className="text-sm text-warning-foreground">
                      Disabled: queued requests wait until it is enabled again.
                    </p>
                  ) : null}
                </div>

                {editing ? (
                  <SubheadEditForm
                    key={subhead.version}
                    environmentId={environmentId}
                    subhead={subhead}
                    projectTitle={projectTitle}
                    ownerTitle={ownerTitle}
                    onCancel={() => setEditing(false)}
                    onSaved={() => {
                      setEditing(false);
                      page.refresh();
                    }}
                    onReload={page.refresh}
                  />
                ) : (
                  <div className="@container/runs flex min-w-0 flex-col gap-6">
                    <div className="flex min-w-0 flex-col gap-5">
                      <Section
                        title="Open runs"
                        detail={`${openRuns.filter((run) => run.status === "running").length} running · ${openRuns.filter((run) => run.status === "queued").length} queued`}
                      >
                        {openRuns.length === 0 ? (
                          <p className="text-sm text-muted-foreground">No run is open.</p>
                        ) : (
                          <>
                            <RunHeader />
                            <ul>{openRuns.map(runRow)}</ul>
                          </>
                        )}
                      </Section>
                      <Section
                        title="History"
                        detail={
                          finished.length >= 50
                            ? "newest 50 finished runs"
                            : `${finished.length} finished`
                        }
                      >
                        <div role="group" aria-label="History filter" className="flex gap-3 text-xs">
                          {FILTERS.map((entry) => (
                            <button
                              key={entry.id}
                              type="button"
                              aria-pressed={filter === entry.id}
                              className={cn(
                                "cursor-pointer hover:text-foreground",
                                filter === entry.id
                                  ? "text-foreground underline"
                                  : "text-muted-foreground",
                              )}
                              onClick={() => setFilter(entry.id)}
                            >
                              {entry.label}
                            </button>
                          ))}
                        </div>
                        {shown.length === 0 ? (
                          <p className="text-sm text-muted-foreground">No runs match.</p>
                        ) : (
                          <>
                            <RunHeader />
                            <ul>{shown.map(runRow)}</ul>
                          </>
                        )}
                        <p className="text-xs text-muted-foreground">
                          Delivery is stored apart from execution. Undelivered runs stay visible
                          here and are never rerouted silently.
                        </p>
                      </Section>
                    </div>
                    <Template subhead={subhead} projectTitle={projectTitle} ownerTitle={ownerTitle} />
                  </div>
                )}
              </>
            )}
          </WorkspacePageContainer>
        </div>
      </div>
      {sending && subhead ? (
        <SubheadSendDialog
          environmentId={environmentId}
          subhead={subhead}
          openRuns={openRuns}
          onClose={() => setSending(false)}
          onSent={page.refresh}
        />
      ) : null}
      <AlertDialog open={retiring} onOpenChange={setRetiring}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Retire {subhead?.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              It stops taking requests and leaves the list. Its name stays reserved and its history
              stays here. This version has no restore.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
            <AlertDialogClose
              render={<Button variant="destructive" />}
              onClick={() => void changeState("retire")}
            >
              Retire
            </AlertDialogClose>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </SidebarInset>
  );
}
