import type { OrchestratorSummary } from "@t3tools/client-runtime/state/orchestrators";
import type { ProjectRoadmapItem } from "@t3tools/contracts";
import { MoreHorizontalIcon, PencilIcon, PlusIcon } from "lucide-react";
import { useMemo, useState, type DragEvent } from "react";

import { useEnvironmentQuery } from "../../state/query";
import {
  moveRoadmapItem,
  projectRoadmapQuery,
  saveRequestForLater,
  saveRoadmapVersion,
} from "../../state/projectRoadmap";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { ProjectQueryState } from "./ProjectQueryState";
import {
  countStatuses,
  formatStatusCounts,
  STAGE_STATUS,
  TASK_STATUS_LABEL,
  type StatusCounts,
  type TaskStatus,
} from "./projectRequests.logic";
import { useTaskStatuses } from "./ProjectRequestsSection";
import { columnOf, moveInput, roadmapColumns, type RoadmapColumn } from "./projectRoadmap.logic";

const DRAG_TYPE = "application/x-t3-roadmap-item";

function useRoadmap(summary: OrchestratorSummary) {
  return useEnvironmentQuery(
    projectRoadmapQuery({
      environmentId: summary.root.environmentId,
      input: { threadId: summary.root.id },
    }),
  );
}

/**
 * The next release (first open version) and the items explicitly in it, for the
 * Release widget; parked items stay off the Dashboard.
 */
export function useNextReleaseItems(summary: OrchestratorSummary) {
  const roadmap = useRoadmap(summary);
  return useMemo(() => {
    const version = roadmap.data?.versions[0] ?? null;
    return {
      version,
      items: version
        ? (roadmap.data?.items ?? []).filter(
            (item) => item.versionId === version.id && !item.parked,
          )
        : [],
    };
  }, [roadmap.data]);
}

/** "Save for later": files an idea as a request in Later without sending it to the orchestrator. */
export function SaveForLater({
  summary,
  onSaved,
}: {
  readonly summary: OrchestratorSummary;
  readonly onSaved?: () => void;
}) {
  const save = useAtomCommand(saveRequestForLater, "Save for later");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    const title = text.trim();
    if (!title) return;
    setBusy(true);
    const result = await save({
      environmentId: summary.root.environmentId,
      input: {
        threadId: summary.root.id,
        title: title.slice(0, 200),
        kind: "change",
        detail: title,
        park: true,
      },
    });
    setBusy(false);
    if (result._tag === "Success") {
      setText("");
      onSaved?.();
    }
  };
  return (
    <form
      className="flex items-center gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <Input
        value={text}
        aria-label="Idea to save for later"
        placeholder="Save an idea for later"
        onChange={(event) => setText(event.target.value)}
      />
      <Button size="xs" variant="outline" type="submit" disabled={busy || !text.trim()}>
        Save for later
      </Button>
    </form>
  );
}

function VersionTitle({
  column,
  next,
  onRename,
}: {
  readonly column: RoadmapColumn;
  /** The automatic next version. */
  readonly next: boolean;
  readonly onRename: (title: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(column.title);
  if (editing) {
    return (
      <form
        className="mb-1"
        onSubmit={(event) => {
          event.preventDefault();
          if (title.trim()) onRename(title.trim());
          setEditing(false);
        }}
      >
        <Input
          autoFocus
          value={title}
          aria-label={`Rename ${column.title}`}
          onChange={(event) => setTitle(event.target.value)}
          onBlur={() => setEditing(false)}
        />
      </form>
    );
  }
  return (
    <h3 className="mb-1 flex items-center gap-1 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
      <span className="truncate">{column.title}</span>
      {next && column.versionId !== null ? (
        <span className="font-normal normal-case text-foreground/60">next</span>
      ) : null}
      <span className="tabular-nums text-foreground/60">{column.items.length}</span>
      {column.versionId !== null ? (
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label={`Rename ${column.title}`}
          onClick={() => {
            setTitle(column.title);
            setEditing(true);
          }}
        >
          <PencilIcon />
        </Button>
      ) : null}
    </h3>
  );
}

const STATUS_TONE: Record<TaskStatus, string> = {
  complete: "bg-foreground/70",
  "for-review": "bg-warning",
  active: "bg-info",
  pending: "bg-muted-foreground/25",
};

/**
 * How far along a version is: "63 · 12 complete · 3 active · 2 for review · 46 pending"
 * and a thin static bar in the same order.
 */
function VersionProgress({ counts }: { readonly counts: StatusCounts }) {
  if (counts.total === 0) return null;
  const parts: ReadonlyArray<[TaskStatus, number]> = [
    ["complete", counts.complete],
    ["for-review", counts.forReview],
    ["active", counts.active],
    ["pending", counts.pending],
  ];
  return (
    <div className="mb-2">
      <p className="text-xs text-muted-foreground">{formatStatusCounts(counts)}</p>
      <div className="mt-1 flex h-1 overflow-hidden rounded-full bg-muted">
        {parts.map(([status, value]) =>
          value > 0 ? (
            <span
              key={status}
              className={STATUS_TONE[status]}
              style={{ width: `${(value / counts.total) * 100}%` }}
            />
          ) : null,
        )}
      </div>
    </div>
  );
}

/**
 * The Roadmap tab: the next version first, filled automatically with the first
 * open version's items and every unversioned item; then each later version
 * (Gitea milestones on the tracker); then Later, the parked items the Dashboard
 * leaves out. Drag a card between columns, or use its Move to menu.
 */
export function ProjectRoadmapWidget({ summary }: { readonly summary: OrchestratorSummary }) {
  const environmentId = summary.root.environmentId;
  const roadmap = useRoadmap(summary);
  const move = useAtomCommand(moveRoadmapItem, "Move on roadmap");
  const saveVersion = useAtomCommand(saveRoadmapVersion, "Save version");
  const [newVersion, setNewVersion] = useState("");
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const columns = useMemo(() => (roadmap.data ? roadmapColumns(roadmap.data) : []), [roadmap.data]);
  const { statuses } = useTaskStatuses(summary);
  const repository = roadmap.data?.tracker?.repository;
  // The same status as the Tasks board and Needs you; the stage only when the
  // task is not in the issue list yet.
  const statusOf = (item: ProjectRoadmapItem): TaskStatus =>
    statuses.get(`${repository}#${item.number}`) ??
    (item.stage ? STAGE_STATUS[item.stage] : "pending");

  if (!roadmap.data) {
    return <ProjectQueryState what="roadmap" error={roadmap.error} onRetry={roadmap.refresh} />;
  }
  if (!roadmap.data.tracker) {
    return (
      <p className="py-2 text-sm text-muted-foreground">
        Name the project's Gitea tracker repository under Customize to plan versions.
      </p>
    );
  }

  const moveTo = async (item: ProjectRoadmapItem, column: RoadmapColumn) => {
    if (columnOf(columns, item)?.key === column.key) return;
    await move({
      environmentId,
      input: {
        threadId: summary.root.id,
        reference: String(item.number),
        ...moveInput(column.target),
      },
    });
    roadmap.refresh();
  };
  const addVersion = async () => {
    const title = newVersion.trim();
    if (!title) return;
    const result = await saveVersion({
      environmentId,
      input: { threadId: summary.root.id, title },
    });
    if (result._tag === "Success") setNewVersion("");
    roadmap.refresh();
  };
  const onDrop = (column: RoadmapColumn) => (event: DragEvent) => {
    event.preventDefault();
    setDropTarget(null);
    const number = Number(event.dataTransfer.getData(DRAG_TYPE));
    const item = roadmap.data?.items.find((candidate) => candidate.number === number);
    if (item) void moveTo(item, column);
  };

  return (
    <section className="flex flex-col gap-2">
      <div className="grid auto-cols-[minmax(220px,1fr)] grid-flow-col gap-px overflow-x-auto border border-border bg-border">
        {columns.map((column, index) => (
          <section
            key={column.key}
            aria-label={column.title}
            className={`min-w-0 bg-background px-2.5 py-2 ${dropTarget === column.key ? "bg-muted/40" : ""}`}
            onDragOver={(event) => {
              if (!event.dataTransfer.types.includes(DRAG_TYPE)) return;
              event.preventDefault();
              setDropTarget(column.key);
            }}
            onDragLeave={() =>
              setDropTarget((current) => (current === column.key ? null : current))
            }
            onDrop={onDrop(column)}
          >
            <VersionTitle
              column={column}
              next={index === 0}
              onRename={(title) =>
                void saveVersion({
                  environmentId,
                  input: { threadId: summary.root.id, id: column.versionId!, title },
                }).then(() => roadmap.refresh())
              }
            />
            {column.target.kind === "later" ? null : (
              <VersionProgress
                counts={countStatuses(column.items.map(statusOf), column.completeCount)}
              />
            )}
            <ul>
              {column.items.map((item) => (
                <li
                  key={item.number}
                  draggable
                  onDragStart={(event) => {
                    event.dataTransfer.setData(DRAG_TYPE, String(item.number));
                    event.dataTransfer.effectAllowed = "move";
                  }}
                  className="flex cursor-grab items-start gap-1 border-b border-border/60 py-1.5 last:border-b-0"
                >
                  <span className="min-w-0 flex-1">
                    <a
                      href={item.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="line-clamp-2 text-sm hover:underline"
                    >
                      {item.title}
                    </a>
                    <span className="text-xs text-muted-foreground">
                      {TASK_STATUS_LABEL[statusOf(item)]}
                    </span>
                  </span>
                  <Menu>
                    <MenuTrigger
                      render={
                        <Button
                          size="icon-xs"
                          variant="ghost"
                          aria-label={`Move #${item.number} to`}
                        />
                      }
                    >
                      <MoreHorizontalIcon />
                    </MenuTrigger>
                    <MenuPopup align="end">
                      {columns
                        .filter((target) => target.key !== column.key)
                        .map((target) => (
                          <MenuItem key={target.key} onClick={() => void moveTo(item, target)}>
                            Move to {target.title}
                          </MenuItem>
                        ))}
                    </MenuPopup>
                  </Menu>
                </li>
              ))}
            </ul>
            {column.target.kind === "later" ? (
              <div className="mt-2">
                <SaveForLater summary={summary} onSaved={roadmap.refresh} />
              </div>
            ) : null}
          </section>
        ))}
        <section aria-label="Add version" className="min-w-0 bg-background px-2.5 py-2">
          <form
            className="flex items-center gap-1"
            onSubmit={(event) => {
              event.preventDefault();
              void addVersion();
            }}
          >
            <Input
              value={newVersion}
              aria-label="New version"
              placeholder="Add a version"
              onChange={(event) => setNewVersion(event.target.value)}
            />
            <Button size="icon-xs" variant="ghost" type="submit" aria-label="Add version">
              <PlusIcon />
            </Button>
          </form>
        </section>
      </div>
      <p className="text-xs text-muted-foreground">
        {roadmap.data.tracker.repository} · Later items stay off the Dashboard.
      </p>
    </section>
  );
}
