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
import { roadmapColumns, type RoadmapColumn } from "./projectRoadmap.logic";

const DRAG_TYPE = "application/x-t3-roadmap-item";

function useRoadmap(summary: OrchestratorSummary) {
  return useEnvironmentQuery(
    projectRoadmapQuery({
      environmentId: summary.root.environmentId,
      input: { threadId: summary.root.id },
    }),
  );
}

/** The next release (first open version) and its items, for the Release widget. */
export function useNextReleaseItems(summary: OrchestratorSummary) {
  const roadmap = useRoadmap(summary);
  return useMemo(() => {
    const version = roadmap.data?.versions[0] ?? null;
    return {
      version,
      items: version
        ? (roadmap.data?.items ?? []).filter((item) => item.versionId === version.id)
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
  onRename,
}: {
  readonly column: RoadmapColumn;
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

/**
 * The Roadmap widget: Later (open items without a version) and one column per
 * open Gitea milestone on the tracker. Drag a card between columns, or use its
 * Move to menu from the keyboard; the first version is the next release.
 */
export function ProjectRoadmapWidget({ summary }: { readonly summary: OrchestratorSummary }) {
  const environmentId = summary.root.environmentId;
  const roadmap = useRoadmap(summary);
  const move = useAtomCommand(moveRoadmapItem, "Move on roadmap");
  const saveVersion = useAtomCommand(saveRoadmapVersion, "Save version");
  const [newVersion, setNewVersion] = useState("");
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const columns = useMemo(() => (roadmap.data ? roadmapColumns(roadmap.data) : []), [roadmap.data]);

  if (!roadmap.data) return null;
  if (!roadmap.data.tracker) {
    return (
      <section className="border-t border-border pt-4">
        <h2 className="mb-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
          Roadmap
        </h2>
        <p className="text-sm text-muted-foreground">
          Name the project's Gitea tracker repository under Customize to plan versions.
        </p>
      </section>
    );
  }

  const moveTo = async (item: ProjectRoadmapItem, column: RoadmapColumn) => {
    if (item.versionId === column.versionId) return;
    await move({
      environmentId,
      input: {
        threadId: summary.root.id,
        reference: String(item.number),
        version: column.versionId === null ? null : column.title,
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
    <section className="border-t border-border pt-4">
      <h2 className="mb-2 flex items-center gap-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
        Roadmap
        <span className="font-normal normal-case text-muted-foreground">
          {roadmap.data.tracker.repository}
        </span>
      </h2>
      <div className="grid auto-cols-[minmax(220px,1fr)] grid-flow-col gap-px overflow-x-auto border border-border bg-border">
        {columns.map((column) => {
          const key = column.versionId === null ? "later" : String(column.versionId);
          return (
            <section
              key={key}
              aria-label={column.title}
              className={`min-w-0 bg-background px-2.5 py-2 ${dropTarget === key ? "bg-muted/40" : ""}`}
              onDragOver={(event) => {
                if (!event.dataTransfer.types.includes(DRAG_TYPE)) return;
                event.preventDefault();
                setDropTarget(key);
              }}
              onDragLeave={() => setDropTarget((current) => (current === key ? null : current))}
              onDrop={onDrop(column)}
            >
              <VersionTitle
                column={column}
                onRename={(title) =>
                  void saveVersion({
                    environmentId,
                    input: { threadId: summary.root.id, id: column.versionId!, title },
                  }).then(() => roadmap.refresh())
                }
              />
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
                        className="block truncate text-sm hover:underline"
                      >
                        {item.title}
                      </a>
                      <span className="text-xs text-muted-foreground">
                        #{item.number}
                        {item.isRequest ? " · request" : ""}
                        {item.stage && item.stage !== "requested" ? ` · ${item.stage}` : ""}
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
                          .filter((target) => target.versionId !== item.versionId)
                          .map((target) => (
                            <MenuItem
                              key={target.versionId ?? "later"}
                              onClick={() => void moveTo(item, target)}
                            >
                              Move to {target.title}
                            </MenuItem>
                          ))}
                      </MenuPopup>
                    </Menu>
                  </li>
                ))}
              </ul>
              {column.versionId === null ? (
                <div className="mt-2">
                  <SaveForLater summary={summary} onSaved={roadmap.refresh} />
                </div>
              ) : null}
            </section>
          );
        })}
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
              placeholder="New version"
              onChange={(event) => setNewVersion(event.target.value)}
            />
            <Button size="icon-xs" variant="ghost" type="submit" aria-label="Add version">
              <PlusIcon />
            </Button>
          </form>
        </section>
      </div>
    </section>
  );
}
