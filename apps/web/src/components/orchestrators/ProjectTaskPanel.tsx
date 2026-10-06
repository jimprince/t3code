import type { OrchestratorSummary } from "@t3tools/client-runtime/state/orchestrators";
import type { ProjectIssue } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { ExternalLinkIcon, XIcon } from "lucide-react";
import { use, useMemo, useState } from "react";

import { useServerConfigs } from "../../state/entities";
import { projectIssueQuery } from "../../state/projectIssues";
import { useEnvironmentQuery } from "../../state/query";
import { resolveThreadIssueBadgeTarget } from "../ThreadIssueBadges";
import { useEmbeddedPages } from "../embeddedPages/useEmbeddedPages";
import ChatMarkdown from "../ChatMarkdown";
import { Button, InlineButton } from "../ui/button";
import { formatIssueAge } from "./projectIssuesBoard.logic";
import { projectReturnState } from "./projectNavigation";
import { ProjectQueryState } from "./ProjectQueryState";
import { TASK_STATUS_LABEL, type TaskStatus } from "./projectRequests.logic";
import {
  ReopenButton,
  SettleButton,
  useOpenThread,
  useSettle,
  useTaskStatuses,
} from "./ProjectRequestsSection";
import { RowMenu } from "./ProjectSection";
import { OpenTaskContext } from "./TaskLink";
import {
  deriveTaskView,
  findListedIssue,
  olderServerTaskNote,
  taskViewStatus,
  type TaskRef,
} from "./taskView.logic";

const hiddenMarkers = (text: string) => text.replace(/<!--[\s\S]*?-->/g, "").trim();

/**
 * One task in a right-hand panel over the project page: its status, the answer
 * or decision, the latest progress, the parts of an epic, its threads, and
 * Settle or Reopen. Settle is the button only when the task is for Brad's review;
 * open work keeps it in the menu, and an epic still under way has none. Closing
 * it (or Back) returns to the page underneath.
 */
export function ProjectTaskPanel({
  summary,
  task,
  onClose,
}: {
  readonly summary: OrchestratorSummary;
  readonly task: TaskRef;
  readonly onClose: () => void;
}) {
  const navigate = useNavigate();
  const pages = useEmbeddedPages();
  const { statuses, query: list } = useTaskStatuses(summary);
  const environment = useServerConfigs().get(summary.root.environmentId)?.environment;
  // A server without projectIssues.get would only answer the request with an error; until the
  // server config arrives the panel just loads.
  const detailed = environment?.capabilities.projectIssueDetail === true;
  const query = useEnvironmentQuery(
    detailed
      ? projectIssueQuery({
          environmentId: summary.root.environmentId,
          input: { rootThreadId: summary.root.id, ...task },
        })
      : null,
  );
  const listedIssue = list.data ? findListedIssue(list.data.issues, task) : null;
  const refresh = () => {
    query.refresh();
    list.refresh();
  };
  const settle = useSettle(summary, refresh);
  const openThread = useOpenThread(summary);
  const openTask = use(OpenTaskContext);
  const [showDetails, setShowDetails] = useState(false);
  const view = useMemo(
    () => (query.data ? deriveTaskView(query.data, list.data?.issues ?? [], statuses) : null),
    [list.data, query.data, statuses],
  );
  const threadTitle = (id: string) =>
    [summary.root, ...summary.descendants].find((thread) => thread.id === id)?.title ?? "Thread";
  const now = query.dataUpdatedAt ?? 0;

  return (
    <aside
      aria-label="Task"
      className="flex w-[420px] min-w-0 shrink-0 flex-col border-l border-border"
    >
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border px-3">
        <span className="min-w-0 flex-1 truncate text-sm font-medium">
          {view ? TASK_STATUS_LABEL[view.status] : "Task"}
        </span>
        <Button size="icon-sm" variant="ghost" aria-label="Close the task" onClick={onClose}>
          <XIcon />
        </Button>
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-3">
        {environment && !detailed ? (
          <OlderServerTask
            issue={listedIssue}
            status={listedIssue ? taskViewStatus(listedIssue, statuses) : null}
            settle={settle}
            note={olderServerTaskNote(environment.serverVersion)}
            listLoaded={list.data !== null}
            listError={list.error}
            onRetry={list.refresh}
          />
        ) : !view || !query.data ? (
          <ProjectQueryState what="task" error={query.error} onRetry={refresh} />
        ) : (
          <>
            <div className="flex flex-col gap-1">
              <h2 className="text-base font-medium">{view.issue.title}</h2>
              {view.kind || view.issue.milestone ? (
                <p className="text-xs text-muted-foreground">
                  {[view.kind, view.issue.milestone?.title].filter(Boolean).join(" · ")}
                </p>
              ) : null}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {view.status === "complete" ? (
                <ReopenButton issue={view.issue} settle={settle} />
              ) : view.status === "for-review" ? (
                <SettleButton issues={[view.issue]} settle={settle} />
              ) : null}
              {view.threadIds[0] ? (
                <Button size="xs" variant="outline" onClick={() => openThread(view.threadIds[0]!)}>
                  Open thread
                </Button>
              ) : null}
              {/* Open work settles from the menu; an epic still under way does not settle. */}
              {(view.status === "pending" || view.status === "active") &&
              !(view.kind === "epic" && view.status === "active") ? (
                <RowMenu
                  label={view.issue.title}
                  items={[
                    {
                      label: "Settle",
                      disabled: settle.isBusy(view.issue),
                      onClick: () => void settle.settle([view.issue]),
                    },
                  ]}
                />
              ) : null}
            </div>
            {view.answer ? (
              <ChatMarkdown
                text={view.answer}
                cwd={undefined}
                environmentId={summary.root.environmentId}
                className="text-sm"
              />
            ) : null}
            {view.progress ? (
              <p className="text-xs text-foreground/80">Latest: {view.progress}</p>
            ) : null}
            {view.children.length > 0 ? (
              <section>
                <h3 className="mb-1 text-xs text-foreground/80">
                  Parts{" "}
                  <span className="tabular-nums text-muted-foreground">
                    {view.children.filter((child) => child.status === "complete").length} of{" "}
                    {view.children.length} complete
                  </span>
                </h3>
                <ul className="divide-y divide-border">
                  {view.children.map((child) => (
                    <li key={child.issue.number} className="flex items-center gap-3 py-1.5">
                      <span className="w-24 shrink-0 text-xs text-muted-foreground">
                        {TASK_STATUS_LABEL[child.status]}
                      </span>
                      <button
                        type="button"
                        className="min-w-0 flex-1 text-left text-sm hover:underline"
                        onClick={() =>
                          openTask?.({
                            host: child.issue.host,
                            repository: child.issue.repository,
                            number: child.issue.number,
                          })
                        }
                      >
                        {child.issue.title}
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}
            {view.threadIds.length > 0 ? (
              <section>
                <h3 className="mb-1 text-xs text-foreground/80">Threads</h3>
                <ul>
                  {view.threadIds.map((id) => (
                    <li key={id}>
                      <button
                        type="button"
                        className="max-w-full py-0.5 text-left text-sm hover:underline"
                        onClick={() => openThread(id)}
                      >
                        {threadTitle(id)}
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}
            <section>
              <p className="text-xs">
                <InlineButton
                  tone="muted"
                  aria-expanded={showDetails}
                  onClick={() => setShowDetails((value) => !value)}
                >
                  {showDetails ? "Hide details" : "Details"}
                </InlineButton>
              </p>
              {showDetails ? (
                <div className="mt-2 flex flex-col gap-3">
                  {hiddenMarkers(query.data.body) ? (
                    <ChatMarkdown
                      text={hiddenMarkers(query.data.body)}
                      cwd={undefined}
                      environmentId={summary.root.environmentId}
                      className="text-sm"
                    />
                  ) : null}
                  {query.data.comments.map((comment) => (
                    <div
                      key={comment.createdAt + comment.author}
                      className="border-l border-border pl-2"
                    >
                      <p className="text-xs text-muted-foreground">
                        {comment.author} · {formatIssueAge(comment.createdAt, now)}
                      </p>
                      <ChatMarkdown
                        text={hiddenMarkers(comment.body)}
                        cwd={undefined}
                        environmentId={summary.root.environmentId}
                        className="text-sm"
                      />
                    </div>
                  ))}
                </div>
              ) : null}
            </section>
            <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
              <a
                href={view.issue.url}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 hover:text-foreground"
              >
                Open in Gitea
                <ExternalLinkIcon className="size-3" />
              </a>
              {(() => {
                const board = resolveThreadIssueBadgeTarget(pages, view.issue);
                return board.kind === "embedded" ? (
                  <button
                    type="button"
                    className="hover:text-foreground"
                    onClick={() =>
                      void navigate({
                        to: "/embedded/$pageId",
                        params: { pageId: board.pageId },
                        search: { repo: board.repo, issue: board.issue },
                        state: projectReturnState({
                          environmentId: summary.root.environmentId,
                          threadId: summary.root.id,
                        }),
                      })
                    }
                  >
                    Status Board
                  </button>
                ) : null;
              })()}
            </div>
          </>
        )}
      </div>
    </aside>
  );
}

/**
 * The task from the issue list the page already holds, for a server that cannot send
 * the whole task: its title and status, Settle or Reopen, and the link to Gitea.
 */
function OlderServerTask({
  issue,
  status,
  settle,
  note,
  listLoaded,
  listError,
  onRetry,
}: {
  readonly issue: ProjectIssue | null;
  readonly status: TaskStatus | null;
  readonly settle: ReturnType<typeof useSettle>;
  readonly note: string;
  readonly listLoaded: boolean;
  readonly listError: string | null;
  readonly onRetry: () => void;
}) {
  return (
    <>
      {issue && status ? (
        <>
          <div className="flex flex-col gap-1">
            <h2 className="text-base font-medium">{issue.title}</h2>
            <p className="text-xs text-muted-foreground">{TASK_STATUS_LABEL[status]}</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {status === "complete" ? (
              <ReopenButton issue={issue} settle={settle} />
            ) : (
              <SettleButton issues={[issue]} settle={settle} />
            )}
          </div>
          <a
            href={issue.url}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
          >
            Open in Gitea
            <ExternalLinkIcon className="size-3" />
          </a>
        </>
      ) : listLoaded ? (
        <p className="text-sm text-muted-foreground">
          The project's task list does not include it.
        </p>
      ) : (
        <ProjectQueryState what="task" error={listError} onRetry={onRetry} />
      )}
      <p className="text-xs text-muted-foreground">{note}</p>
    </>
  );
}
