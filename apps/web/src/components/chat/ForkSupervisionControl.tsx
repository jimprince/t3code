import {
  sortActiveThreadsByOrderKey,
  sortPinnedThreadsByOrderKey,
  sortSettledThreads,
} from "@t3tools/client-runtime/state/thread-sort";
import { supervisionKey, supervisionThreadKey } from "@t3tools/client-runtime/state/fork-nesting";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { ChevronDownIcon } from "lucide-react";
import { useState } from "react";
import { cn } from "../../lib/utils";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { useNowMinute } from "../../hooks/useNowMinute";
import { useThreadNestingActions } from "../../hooks/useThreadNesting";
import { useProjects, useServerConfigs, useThreadShells } from "../../state/entities";
import { useSupervisionForest, useSupervisionMetadata } from "../../state/forkSupervision";
import { Button } from "../ui/button";
import { SupervisionWorkerRow } from "./SupervisionWorkerRow";
import { ThreadDetailsSection } from "./ThreadDetailsSection";

const PAGE_SIZE = 24;

/** Organizational workers appear beside native execution lineage, never as delegated-task results. */
export function ForkSupervisionControl(props: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
}) {
  const forest = useSupervisionForest();
  const threads = useThreadShells();
  const metadata = useSupervisionMetadata();
  const configs = useServerConfigs();
  const projects = useProjects();
  const nowMinute = useNowMinute();
  const { setThreadParent } = useThreadNestingActions();
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const [settledOpen, setSettledOpen] = useState(false);
  const rows = forest.children.get(supervisionKey(props.environmentId, props.threadId)) ?? [];
  const active = [
    ...sortPinnedThreadsByOrderKey(rows.filter((thread) => thread.pinnedAt !== null)),
    ...sortActiveThreadsByOrderKey(
      rows.filter((thread) => thread.pinnedAt === null && thread.settledOverride !== "settled"),
    ),
  ];
  const settled = sortSettledThreads(
    rows.filter((thread) => thread.pinnedAt === null && thread.settledOverride === "settled"),
  );
  if (active.length + settled.length === 0) return null;
  const remoteParent = metadata.find(
    (row) => row.environmentId === props.environmentId && row.threadId === props.threadId,
  )?.remoteParent;
  const remoteParentTitle = remoteParent
    ? threads.find(
        (thread) =>
          thread.environmentId === remoteParent.environmentId &&
          thread.id === remoteParent.threadId,
      )?.title
    : undefined;
  const parentProjectId = threads.find(
    (thread) => thread.environmentId === props.environmentId && thread.id === props.threadId,
  )?.projectId;
  const now = `${nowMinute}:00Z`;
  const moveToSidebar = (child: (typeof rows)[number]) => {
    void setThreadParent(scopeThreadRef(child.environmentId, child.id), null);
  };
  const renderRow = (thread: (typeof rows)[number]) => {
    const providerId = thread.runtime?.providerInstanceId ?? thread.providerInstanceId;
    return (
      <SupervisionWorkerRow
        key={supervisionThreadKey(thread)}
        child={thread}
        providerName={
          configs
            .get(thread.environmentId)
            ?.providers.find((entry) => entry.instanceId === providerId)?.displayName
        }
        projectTitle={
          thread.projectId === parentProjectId
            ? undefined
            : projects.find(
                (entry) =>
                  entry.environmentId === thread.environmentId && entry.id === thread.projectId,
              )?.title
        }
        now={now}
        onMoveToSidebar={moveToSidebar}
      />
    );
  };
  return (
    <ThreadDetailsSection headingId="fork-supervision-heading" title="Workers">
      {remoteParentTitle ? <p className="px-1.5 text-xs">Parent: {remoteParentTitle}</p> : null}
      {active.slice(0, visibleCount).map(renderRow)}
      {settled.length > 0 ? (
        <>
          <button
            type="button"
            onClick={() => setSettledOpen((open) => !open)}
            aria-expanded={settledOpen}
            className="mt-1 flex h-7 w-full items-center gap-2 rounded-md px-1.5 text-left text-xs font-medium hover:bg-accent/40"
          >
            <span className="shrink-0">
              {settledOpen ? "Settled" : `Settled (${settled.length})`}
            </span>
            <span aria-hidden className="h-px min-w-2 flex-1 bg-border/60" />
            <ChevronDownIcon
              aria-hidden
              className={cn("size-3 shrink-0", settledOpen && "rotate-180")}
            />
          </button>
          {settledOpen ? settled.slice(0, visibleCount).map(renderRow) : null}
        </>
      ) : null}
      {active.length > visibleCount || (settledOpen && settled.length > visibleCount) ? (
        <Button
          variant="ghost"
          size="compact"
          onClick={() => setVisibleCount((n) => n + PAGE_SIZE)}
        >
          Show more
        </Button>
      ) : null}
    </ThreadDetailsSection>
  );
}
