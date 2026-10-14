import { issueNumber, type MoveTo } from "@t3tools/client-runtime/dashboard/order";
import type { DashboardTask } from "@t3tools/contracts";
import { EllipsisIcon, GripVerticalIcon } from "lucide-react";
import {
  createContext,
  use,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type KeyboardEvent,
  type ReactNode,
} from "react";

import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { Dialog, DialogHeader, DialogPopup, DialogTitle } from "../ui/dialog";
import { Input } from "../ui/input";
import {
  Menu,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuShortcut,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
  MenuTrigger,
} from "../ui/menu";
import { useDashboardUi } from "./context";
import { isEpicHeader, type PlanWorkstreamEntry, type ScopedProject } from "./dashboard.logic";
import type { Destination } from "./orderActions";
import { TaskRow } from "./parts";

/** A workstream a task can go to: an epic, or Other work (no epic). */
export interface PlanDestination extends Destination {
  readonly key: string;
  /** Its queued rows in order. */
  readonly next: DashboardTask[];
}

type Dragged =
  | { readonly kind: "task"; readonly task: DashboardTask; readonly from: PlanDestination }
  | { readonly kind: "workstream"; readonly id: string };
interface DropMark {
  readonly id: string;
  readonly side: "before" | "after" | "into";
}

interface PlanOrder {
  readonly scoped: ScopedProject;
  readonly destinations: ReadonlyArray<PlanDestination>;
  readonly dragging: Dragged | null;
  readonly setDragging: (dragged: Dragged | null) => void;
  readonly over: DropMark | null;
  readonly setOver: (mark: DropMark | null) => void;
}
const PlanOrderContext = createContext<PlanOrder | null>(null);
const usePlanOrder = () => {
  const order = use(PlanOrderContext);
  if (!order) throw new Error("usePlanOrder outside PlanOrderProvider");
  return order;
};

/** The workstream a placement lands in: an epic's number, or null for Other work. */
export function destinationOf(entry: PlanWorkstreamEntry): PlanDestination {
  const epic = isEpicHeader(entry.workstream) ? issueNumber(entry.workstream.id) : null;
  return {
    key: entry.workstream.id,
    partOf: epic,
    title: epic === null ? "Other work" : entry.workstream.title,
    next: entry.next,
  };
}

/** The destinations of a project's Plan, in the order shown, with Other work always last. */
export function planDestinations(entries: ReadonlyArray<PlanWorkstreamEntry>): PlanDestination[] {
  const flat = entries.flatMap(function walk(entry): PlanWorkstreamEntry[] {
    return [entry, ...entry.children.flatMap(walk)];
  });
  const destinations = flat.map(destinationOf);
  const epics = destinations.filter((destination) => destination.partOf !== null);
  const other = destinations.find((destination) => destination.partOf === null) ?? {
    key: "other-work",
    partOf: null,
    title: "Other work",
    next: [],
  };
  return [...epics, other];
}

/** Shares the drag in progress and the destinations among the rows of one project's Plan. */
export function PlanOrderProvider({
  scoped,
  entries,
  children,
}: {
  readonly scoped: ScopedProject;
  readonly entries: ReadonlyArray<PlanWorkstreamEntry>;
  readonly children: ReactNode;
}) {
  const [dragging, setDragging] = useState<Dragged | null>(null);
  const [over, setOver] = useState<DropMark | null>(null);
  const destinations = useMemo(() => planDestinations(entries), [entries]);
  const value = useMemo(
    () => ({ scoped, destinations, dragging, setDragging, over, setOver }),
    [scoped, destinations, dragging, over],
  );
  return <PlanOrderContext value={value}>{children}</PlanOrderContext>;
}

/** The destination a New item belongs to by its Part of line, else Other work. */
export function usePlanDestinations() {
  const { destinations } = usePlanOrder();
  return useMemo(
    () => ({
      destinations,
      destinationFor: (task: Pick<DashboardTask, "partOf">) =>
        destinations.find((destination) => destination.partOf === (task.partOf ?? null)) ??
        destinations.at(-1)!,
    }),
    [destinations],
  );
}

/** The half of a row the pointer is in, so a drop lands before or after it. */
const sideOf = (event: DragEvent<HTMLElement>): "before" | "after" => {
  const box = event.currentTarget.getBoundingClientRect();
  return event.clientY < box.top + box.height / 2 ? "before" : "after";
};

const dropLine = (mark: DropMark | null, id: string) =>
  mark?.id !== id
    ? "border-y-2 border-transparent"
    : mark.side === "before"
      ? "border-y-2 border-transparent border-t-primary"
      : mark.side === "after"
        ? "border-y-2 border-transparent border-b-primary"
        : "border-y-2 border-transparent bg-accent/50";

function DragHandle({
  label,
  onStart,
  rowRef,
}: {
  readonly label: string;
  readonly onStart: () => void;
  readonly rowRef: React.RefObject<HTMLElement | null>;
}) {
  const { setDragging, setOver } = usePlanOrder();
  return (
    <span
      draggable
      aria-label={label}
      className="flex w-3 shrink-0 cursor-grab justify-center text-muted-foreground/60 hover:text-foreground"
      onDragStart={(event) => {
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("text/plain", label);
        if (rowRef.current) event.dataTransfer.setDragImage(rowRef.current, 0, 0);
        onStart();
      }}
      onDragEnd={() => {
        setDragging(null);
        setOver(null);
      }}
    >
      <GripVerticalIcon className="size-3" aria-hidden />
    </span>
  );
}

/** A queued task row: handle, position, the row itself, and its menu. */
export function QueuedRow({
  task,
  entry,
  position,
}: {
  readonly task: DashboardTask;
  readonly entry: PlanWorkstreamEntry;
  readonly position: number;
}) {
  const ui = useDashboardUi();
  const order = usePlanOrder();
  const row = useRef<HTMLDivElement>(null);
  const here = destinationOf(entry);
  const move = (to: MoveTo, destination: PlanDestination = here) =>
    ui.order.place(order.scoped, task, {
      destination,
      list: destination.next,
      move: to,
      origin: here.next,
    });
  const key = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget) return;
    if (event.altKey && event.key === "ArrowUp") void move({ to: "up" });
    else if (event.altKey && event.key === "ArrowDown") void move({ to: "down" });
    else if (event.key.toLowerCase() === "n" && !event.metaKey && !event.ctrlKey && !event.altKey)
      void move({ to: "top" });
    else return;
    event.preventDefault();
  };
  const dragged = order.dragging;
  const droppable = dragged?.kind === "task" && dragged.task.id !== task.id;
  return (
    <div
      ref={row}
      role="group"
      aria-label={`${position}. ${task.title}`}
      tabIndex={0}
      data-testid="queued-row"
      className={cn(
        "flex items-start outline-none focus-visible:bg-accent/40",
        dropLine(order.over, task.id),
        dragged?.kind === "task" && dragged.task.id === task.id && "opacity-50",
      )}
      onKeyDown={key}
      onDragOver={(event) => {
        if (!droppable) return;
        event.preventDefault();
        const side = sideOf(event);
        if (order.over?.id !== task.id || order.over.side !== side)
          order.setOver({ id: task.id, side });
      }}
      onDrop={(event) => {
        if (!droppable || dragged?.kind !== "task") return;
        event.preventDefault();
        const side = order.over?.id === task.id ? order.over.side : sideOf(event);
        order.setOver(null);
        order.setDragging(null);
        // Another workstream's row takes the task into that workstream, before or after the row.
        void ui.order.place(order.scoped, dragged.task, {
          destination: here,
          list: here.next,
          move: { to: side === "into" ? "top" : side, id: task.id },
          origin: dragged.from.next,
        });
      }}
    >
      <span className="flex h-6 items-center">
        <DragHandle
          label={`Drag #${issueNumber(task.id) ?? ""}`}
          rowRef={row}
          onStart={() => order.setDragging({ kind: "task", task, from: here })}
        />
      </span>
      <span className="w-5 shrink-0 pt-0.5 text-right text-xs text-muted-foreground tabular-nums">
        {position}
      </span>
      <div className="min-w-0 flex-1 pl-1">
        <TaskRow scoped={order.scoped} task={task} flush />
      </div>
      <RowMenu task={task} entry={entry} where="queued" />
    </div>
  );
}

/** A task that is started, or waiting on Brad before it has a place: no handle, no number. */
export function ActiveRow({ task }: { readonly task: DashboardTask }) {
  const { scoped } = usePlanOrder();
  return (
    <div className="flex items-start">
      <span className="w-6.5 shrink-0" />
      <div className="min-w-0 flex-1 pl-1">
        <TaskRow scoped={scoped} task={task} flush />
      </div>
      <span className="w-5 shrink-0" />
    </div>
  );
}

/** The workstream header's number and handle, and the drop target for tasks and workstreams. */
export function WorkstreamOrder({
  entry,
  number,
  children,
}: {
  readonly entry: PlanWorkstreamEntry;
  readonly number: number | null;
  readonly children: ReactNode;
}) {
  const ui = useDashboardUi();
  const order = usePlanOrder();
  const row = useRef<HTMLDivElement>(null);
  const workstream = entry.workstream;
  const draggedTask = order.dragging?.kind === "task" ? order.dragging.task : null;
  const draggedWs = order.dragging?.kind === "workstream" ? order.dragging.id : null;
  const epics = order.destinations.filter((destination) => destination.partOf !== null);
  const droppable =
    draggedTask !== null || (draggedWs !== null && draggedWs !== workstream.id && number !== null);
  const epicEntries = useMemo(
    () =>
      epics.map((destination) => ({
        id: destination.key,
        rank: order.scoped.project.workstreams.find((ws) => ws.id === destination.key)?.rank,
      })),
    [epics, order.scoped.project.workstreams],
  );
  const here = destinationOf(entry);
  return (
    <div
      ref={row}
      className={cn("flex items-center", droppable && dropLine(order.over, workstream.id))}
      onDragOver={(event) => {
        if (!droppable) return;
        event.preventDefault();
        const side = draggedWs !== null ? sideOf(event) : "into";
        if (order.over?.id !== workstream.id || order.over.side !== side)
          order.setOver({ id: workstream.id, side });
      }}
      onDrop={(event) => {
        if (!droppable) return;
        event.preventDefault();
        const side = draggedWs !== null ? sideOf(event) : "into";
        order.setOver(null);
        order.setDragging(null);
        if (draggedTask) {
          const from = order.dragging?.kind === "task" ? order.dragging.from : here;
          void ui.order.place(order.scoped, draggedTask, {
            destination: here,
            list: here.next,
            move: { to: "top" },
            origin: from.next,
          });
        } else if (draggedWs && side !== "into") {
          const moving = order.scoped.project.workstreams.find((ws) => ws.id === draggedWs);
          void ui.order.place(
            order.scoped,
            { id: draggedWs, rank: moving?.rank },
            {
              destination: { partOf: null, title: "" },
              list: epicEntries,
              move: { to: side, id: workstream.id },
              origin: epicEntries,
              workstream: moving?.title ?? "Workstream",
            },
          );
        }
      }}
    >
      <span className="flex w-6.5 shrink-0 items-center">
        {number === null ? null : (
          <>
            <DragHandle
              label={`Drag ${workstream.title}`}
              rowRef={row}
              onStart={() => order.setDragging({ kind: "workstream", id: workstream.id })}
            />
            <span className="w-3.5 text-right text-xs text-muted-foreground tabular-nums">
              {number}
            </span>
          </>
        )}
      </span>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

/** Do next / Move / Set workstream / Change type / Back to New / Duplicate of / Later. */
export function RowMenu({
  task,
  entry,
  where,
}: {
  readonly task: DashboardTask;
  readonly entry: PlanWorkstreamEntry | null;
  readonly where: "queued" | "new";
}) {
  const ui = useDashboardUi();
  const order = usePlanOrder();
  const [duplicate, setDuplicate] = useState(false);
  const [reference, setReference] = useState("");
  const here = entry ? destinationOf(entry) : null;
  const origin = here?.next ?? [];
  const fresh = where === "new";
  const own = usePlanDestinations().destinationFor(task);
  const go = (destination: PlanDestination, move: MoveTo) =>
    void ui.order.place(order.scoped, task, {
      destination,
      list: destination.next,
      move,
      origin,
    });
  const parsed = /^#?(\d+)$/.exec(reference.trim())?.[1];
  return (
    <>
      <Menu>
        <MenuTrigger
          render={
            <button
              type="button"
              aria-label={`Order #${issueNumber(task.id) ?? ""}`}
              className="ml-1 flex h-6 w-5 shrink-0 items-center justify-center text-muted-foreground hover:text-foreground"
            >
              <EllipsisIcon className="size-3.5" aria-hidden />
            </button>
          }
        />
        <MenuPopup align="end">
          {fresh ? null : (
            <>
              <MenuItem onClick={() => go(own, { to: "top" })}>
                Do next<MenuShortcut>N</MenuShortcut>
              </MenuItem>
              <MenuItem onClick={() => go(own, { to: "up" })}>
                Move up<MenuShortcut>⌥↑</MenuShortcut>
              </MenuItem>
              <MenuItem onClick={() => go(own, { to: "down" })}>
                Move down<MenuShortcut>⌥↓</MenuShortcut>
              </MenuItem>
              <MenuItem onClick={() => go(own, { to: "bottom" })}>Move to last</MenuItem>
              <MenuSeparator />
            </>
          )}
          <MenuSub>
            <MenuSubTrigger>Do next in…</MenuSubTrigger>
            <MenuSubPopup>
              {order.destinations.map((destination) => (
                <MenuItem key={destination.key} onClick={() => go(destination, { to: "top" })}>
                  {destination.title}
                </MenuItem>
              ))}
            </MenuSubPopup>
          </MenuSub>
          <MenuSub>
            <MenuSubTrigger>Set workstream…</MenuSubTrigger>
            <MenuSubPopup>
              {order.destinations.map((destination) => (
                <MenuItem
                  key={destination.key}
                  onClick={() =>
                    fresh
                      ? void ui.order.keepNew(order.scoped, task, destination)
                      : go(destination, { to: "bottom" })
                  }
                >
                  {destination.title}
                </MenuItem>
              ))}
            </MenuSubPopup>
          </MenuSub>
          <MenuSub>
            <MenuSubTrigger>Change type…</MenuSubTrigger>
            <MenuSubPopup>
              <MenuItem onClick={() => void ui.order.setType(order.scoped, task, "task")}>
                Task
              </MenuItem>
              <MenuItem onClick={() => void ui.order.setType(order.scoped, task, "bug")}>
                Bug
              </MenuItem>
              <MenuItem onClick={() => void ui.order.setType(order.scoped, task, "epic")}>
                Epic
              </MenuItem>
            </MenuSubPopup>
          </MenuSub>
          <MenuSeparator />
          {fresh ? null : (
            <MenuItem onClick={() => void ui.order.backToNew(order.scoped, task, origin)}>
              Back to New
            </MenuItem>
          )}
          <MenuItem onClick={() => setDuplicate(true)}>Duplicate of…</MenuItem>
          <MenuItem onClick={() => void ui.order.later(order.scoped, task)}>Later</MenuItem>
        </MenuPopup>
      </Menu>
      <Dialog open={duplicate} onOpenChange={setDuplicate}>
        <DialogPopup className="max-w-sm">
          <DialogHeader>
            <DialogTitle>#{issueNumber(task.id)} is a duplicate of</DialogTitle>
          </DialogHeader>
          <form
            className="flex items-center gap-2 px-6 pb-5"
            onSubmit={(event) => {
              event.preventDefault();
              if (!parsed) return;
              setDuplicate(false);
              setReference("");
              void ui.order.duplicateOf(order.scoped, task, parsed);
            }}
          >
            <Input
              autoFocus
              aria-label="Issue number"
              size="compact"
              placeholder="#295"
              value={reference}
              onChange={(event) => setReference(event.target.value)}
            />
            <Button type="submit" size="xs" disabled={!parsed}>
              Close it
            </Button>
          </form>
        </DialogPopup>
      </Dialog>
    </>
  );
}
