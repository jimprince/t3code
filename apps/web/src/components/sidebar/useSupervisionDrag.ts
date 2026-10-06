import { supervisionDropCommand } from "../../state/forkSupervision";
import { randomUUID } from "../../lib/utils";
import { useRef, useState } from "react";
import type { DragMoveEvent, DragEndEvent, DragStartEvent } from "@dnd-kit/core";
import { CommandId } from "@t3tools/contracts";
import type { supervisionForest } from "@t3tools/client-runtime/state/fork-nesting";
import { useAtomCommand } from "../../state/use-atom-command";
import type { SidebarListItem } from "../Sidebar.logic";
import { supervisionDragIntent, type SupervisionDragIntent } from "./supervisionDragIntent";
import { planSupervisionDrop } from "./supervisionDrop.logic";

export function useSupervisionDrag(forest: ReturnType<typeof supervisionForest>) {
  const commit = useAtomCommand(supervisionDropCommand);
  const current = useRef<SupervisionDragIntent>({ kind: "reorder" });
  const x = useRef({ start: 0, current: 0 });
  const [intent, setIntent] = useState(current.current);
  const start = (event: DragStartEvent) => {
    const pointer = event.activatorEvent as PointerEvent;
    x.current = { start: pointer.clientX, current: pointer.clientX };
    current.current = { kind: "reorder" };
    setIntent(current.current);
  };
  const pointer = (value: number) => {
    x.current.current = value;
  };
  const move = (event: DragMoveEvent) => {
    current.current = supervisionDragIntent({
      previous: current.current,
      dx: x.current.current - x.current.start,
      sourceKey: String(event.active.id),
      overKey: event.over === null ? null : String(event.over.id),
      forest,
    });
    setIntent(current.current);
  };
  const end = (event: DragEndEvent, items: ReadonlyArray<SidebarListItem>): boolean => {
    const next = current.current;
    current.current = { kind: "reorder" };
    setIntent(current.current);
    const plan = planSupervisionDrop({
      forest,
      items,
      intent: next,
      sourceKey: String(event.active.id),
      overKey: event.over ? String(event.over.id) : null,
      commandId: CommandId.make(randomUUID()),
    });
    if (plan.command) void commit(plan.command);
    return plan.handled;
  };
  return { intent, start, pointer, move, end };
}
