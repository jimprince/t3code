import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import type {
  AgentPanelWorkflowGroup,
  RuntimeSubagent,
} from "@t3tools/client-runtime/state/subagentRuntime";
import type { EnvironmentId, ScopedThreadRef, ThreadId } from "@t3tools/contracts";
import { useRouter } from "@tanstack/react-router";
import * as Schema from "effect/Schema";
import { ChevronDownIcon, PanelLeftIcon } from "lucide-react";
import { type ReactNode, useCallback, useMemo, useState } from "react";

import {
  type AgentsPanelEntry,
  isAgentsPanelEntrySettled,
  shelveAgentsPanelEntries,
} from "~/agentsPanelShelf.logic";
import { useLocalStorage } from "~/hooks/useLocalStorage";
import { useThreadNestingActions } from "~/hooks/useThreadNesting";
import { cn } from "~/lib/utils";
import { useProject, useThreadShell, useThreadShells } from "~/state/entities";
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
  const threads = useThreadShells();
  return useMemo(
    () =>
      thread === null
        ? []
        : listNestedThreads(threads, {
            environmentId: thread.environmentId,
            threadId: thread.id,
          }),
    [threads, thread],
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
  const project = useProject(scopeProjectRef(thread.environmentId, thread.projectId));
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
          {status.label} · {project?.title ?? thread.projectId} · {thread.modelSelection.model}
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

const SETTLED_SHELF_EXPANDED_KEY = "t3code:agents-panel:settled-expanded";
const NO_KEYS: ReadonlySet<string> = new Set();

/** Mirrors the sidebar's Settled shelf header: label, hairline, chevron. */
function SettledShelfHeader({
  count,
  expanded,
  onToggle,
}: {
  count: number;
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={expanded}
      className="mt-1 flex h-7 w-full items-center gap-2 rounded-md px-1.5 text-left text-xs font-medium text-muted-foreground/60 hover:text-muted-foreground"
    >
      <span className="shrink-0">{expanded ? "Settled" : `Settled (${count})`}</span>
      <span aria-hidden className="h-px min-w-2 flex-1 bg-border/60" />
      <ChevronDownIcon
        aria-hidden
        className={cn("size-3 shrink-0 transition-transform", expanded && "rotate-180")}
      />
    </button>
  );
}

/**
 * The Agents panel list: nested threads, workflow runs, and direct spawns in
 * one start-ordered list, with settled rows folded into a collapsed Settled
 * shelf. Rows the viewer saw active stay in place when they settle, so work
 * finishing never pulls rows out from under the reader; they shelve on the
 * next mount. Upstream's workflow and agent rows render through callbacks.
 */
export function AgentsPanelEntries({
  environmentId,
  threadId,
  threads,
  workflows,
  directAgents,
  renderWorkflow,
  renderAgent,
}: {
  environmentId: EnvironmentId | null;
  threadId: ThreadId | null;
  threads: ReadonlyArray<EnvironmentThreadShell>;
  workflows: ReadonlyArray<AgentPanelWorkflowGroup>;
  directAgents: ReadonlyArray<RuntimeSubagent>;
  renderWorkflow: (group: AgentPanelWorkflowGroup) => ReactNode;
  renderAgent: (agent: RuntimeSubagent) => ReactNode;
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
  const [settledExpanded, setSettledExpanded] = useLocalStorage(
    SETTLED_SHELF_EXPANDED_KEY,
    false,
    Schema.Boolean,
  );

  // Rows seen active while this panel shows this thread. Recorded during
  // render (React's "information from previous renders" pattern), so a row
  // that settles later is still kept in place; switching threads starts over.
  const owner = environmentId === null || threadId === null ? null : `${environmentId}:${threadId}`;
  const [seenActive, setSeenActive] = useState<{
    readonly owner: string | null;
    readonly keys: ReadonlySet<string>;
  }>({ owner, keys: NO_KEYS });
  const keepActiveKeys = seenActive.owner === owner ? seenActive.keys : NO_KEYS;
  const { active, settled } = shelveAgentsPanelEntries({
    threads,
    workflows,
    directAgents,
    keepActiveKeys,
  });
  const newlySeen = active
    .filter((entry) => !isAgentsPanelEntrySettled(entry) && !keepActiveKeys.has(entry.key))
    .map((entry) => entry.key);
  if (seenActive.owner !== owner || newlySeen.length > 0) {
    setSeenActive({ owner, keys: new Set([...keepActiveKeys, ...newlySeen]) });
  }

  const renderEntry = (entry: AgentsPanelEntry) => {
    switch (entry.kind) {
      case "thread":
        return (
          <NestedThreadRow
            key={entry.key}
            thread={entry.thread}
            onOpen={openThread}
            onMoveToSidebar={moveToSidebar}
          />
        );
      case "workflow":
        return (
          <div key={entry.key} className="py-1">
            {renderWorkflow(entry.group)}
          </div>
        );
      case "agent":
        return <div key={entry.key}>{renderAgent(entry.agent)}</div>;
    }
  };

  return (
    <div className="flex flex-col">
      {active.map(renderEntry)}
      {settled.length > 0 ? (
        <SettledShelfHeader
          count={settled.length}
          expanded={settledExpanded}
          onToggle={() => setSettledExpanded((value) => !value)}
        />
      ) : null}
      {settledExpanded ? settled.map(renderEntry) : null}
    </div>
  );
}
