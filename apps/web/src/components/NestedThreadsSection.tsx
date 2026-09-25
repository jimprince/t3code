import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import type { EnvironmentId, ScopedThreadRef, ThreadId } from "@t3tools/contracts";
import { useRouter } from "@tanstack/react-router";
import { PanelLeftIcon } from "lucide-react";
import { useCallback, useMemo } from "react";

import { useThreadNestingActions } from "~/hooks/useThreadNesting";
import { cn } from "~/lib/utils";
import { useThreadShell, useThreadShellsForProjectRefs } from "~/state/entities";
import { listNestedThreads } from "~/threadNesting.logic";
import { buildThreadRouteParams } from "~/threadRoutes";
import { formatRelativeTimeLabel } from "~/timestampFormat";
import { resolveSidebarThreadStatus, resolveThreadStatusPill } from "./Sidebar.logic";
import { Button } from "./ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

/** Threads nested under the given thread, for the Agents panel. Empty until its shell loads. */
export function useNestedThreads(
  environmentId: EnvironmentId | null,
  threadId: ThreadId | null,
): ReadonlyArray<EnvironmentThreadShell> {
  const thread = useThreadShell(
    environmentId === null || threadId === null ? null : scopeThreadRef(environmentId, threadId),
  );
  // Nesting stays inside one project, so the project's shells are enough.
  const projectThreads = useThreadShellsForProjectRefs(
    thread === null ? [] : [scopeProjectRef(thread.environmentId, thread.projectId)],
  );
  return useMemo(
    () =>
      thread === null
        ? []
        : listNestedThreads(projectThreads, {
            environmentId: thread.environmentId,
            threadId: thread.id,
          }),
    [projectThreads, thread],
  );
}

// Static dots only: the panel never animates status.
function nestedThreadStatus(thread: EnvironmentThreadShell) {
  const pill = resolveThreadStatusPill({ thread });
  if (pill !== null) return { label: pill.label, dotClass: pill.dotClass };
  return resolveSidebarThreadStatus(thread) === "failed"
    ? { label: "Failed", dotClass: "bg-destructive" }
    : { label: "Idle", dotClass: "bg-muted-foreground/50" };
}

function NestedThreadRow({
  thread,
  onOpen,
  onMoveToSidebar,
}: {
  thread: EnvironmentThreadShell;
  onOpen: (threadRef: ScopedThreadRef) => void;
  onMoveToSidebar: (threadRef: ScopedThreadRef) => void;
}) {
  const threadRef = scopeThreadRef(thread.environmentId, thread.id);
  const status = nestedThreadStatus(thread);
  return (
    <div className="flex items-center gap-1 rounded-md hover:bg-accent/40">
      <button
        type="button"
        onClick={() => onOpen(threadRef)}
        className="grid min-w-0 flex-1 grid-cols-[0.375rem_minmax(0,1fr)_auto] grid-rows-[1.25rem_1rem] items-center gap-x-2 px-1.5 py-1 text-left"
      >
        <span className="col-start-1 row-start-1 flex items-center">
          <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", status.dotClass)} />
        </span>
        <span className="col-start-2 row-start-1 min-w-0 truncate text-sm font-medium">
          {thread.title}
        </span>
        <span className="col-start-3 row-start-1 font-mono text-2xs text-muted-foreground/80">
          {formatRelativeTimeLabel(thread.latestUserMessageAt ?? thread.updatedAt)}
        </span>
        <span className="col-start-2 col-end-4 row-start-2 truncate font-mono text-2xs text-muted-foreground/70">
          {status.label} · {thread.modelSelection.model}
        </span>
      </button>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              size="icon-micro"
              variant="ghost-muted"
              aria-label={`Move ${thread.title} to sidebar`}
              onClick={() => onMoveToSidebar(threadRef)}
            />
          }
        >
          <PanelLeftIcon aria-hidden className="size-3" />
        </TooltipTrigger>
        <TooltipPopup side="top">Move to sidebar</TooltipPopup>
      </Tooltip>
    </div>
  );
}

/** "Threads" section of the Agents panel: the threads nested under this one. */
export function NestedThreadsSection({
  threads,
}: {
  threads: ReadonlyArray<EnvironmentThreadShell>;
}) {
  const router = useRouter();
  const { setThreadParent } = useThreadNestingActions();
  const openThread = useCallback(
    (threadRef: ScopedThreadRef) =>
      void router.navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(threadRef),
      }),
    [router],
  );
  const moveToSidebar = useCallback(
    (threadRef: ScopedThreadRef) => void setThreadParent(threadRef, null),
    [setThreadParent],
  );
  if (threads.length === 0) return null;
  return (
    <section>
      <div className="px-1.5 pt-1 text-3xs font-medium uppercase tracking-wider text-muted-foreground">
        Threads
      </div>
      {threads.map((thread) => (
        <NestedThreadRow
          key={thread.id}
          thread={thread}
          onOpen={openThread}
          onMoveToSidebar={moveToSidebar}
        />
      ))}
    </section>
  );
}
