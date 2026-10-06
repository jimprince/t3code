import * as Effect from "effect/Effect";
import { supervision } from "../../state/forkSupervision";
import { randomUUID } from "../../lib/utils";
import { useRef, useState } from "react";
import type { DragMoveEvent, DragEndEvent, DragStartEvent } from "@dnd-kit/core";
import { CommandId } from "@t3tools/contracts";
import { supervisionKey, type supervisionForest } from "@t3tools/client-runtime/state/forkNesting";
import { planPinnedReorder } from "@t3tools/client-runtime/state/thread-sort";
import { createEnvironmentRpcCommand } from "@t3tools/client-runtime/state/runtime";
import { connectionAtomRuntime } from "../../connection/runtime";
import { useAtomCommand } from "../../state/use-atom-command";
import { resolveSidebarDropTarget, type SidebarListItem } from "../Sidebar.logic";
import {
  supervisionDragIntent,
  directSiblingBucket,
  type SupervisionDragIntent,
} from "./supervisionDragIntent";

const dropCommand = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "supervision-drop",
  tag: "fork.threads.supervision.drop",
  onSuccess: ({ environmentId }, registry) =>
    Effect.sync(() => registry.refresh(supervision.query({ environmentId, input: {} }))),
});
export function useSupervisionDrag(forest: ReturnType<typeof supervisionForest>) {
  const commit = useAtomCommand(dropCommand);
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
    const sourceKey = String(event.active.id);
    const source = forest.byKey.get(sourceKey);
    if (!source || !event.over) return false;
    const commandId = CommandId.make(randomUUID());
    if (next.kind === "nest") {
      const parent = forest.byKey.get(next.parentKey);
      if (!parent) return true;
      void commit({
        environmentId: source.environmentId,
        input: { commandId, threadId: source.id, parentThreadId: parent.id },
      });
      return true;
    }
    const parentKey = forest.parentByKey.get(sourceKey);
    if (parentKey === undefined) return false;
    const overKey = String(event.over.id);
    const over = forest.byKey.get(overKey);
    if (over) {
      const siblings = directSiblingBucket(forest, source);
      if (!siblings.includes(over)) return true;
      const ordered = siblings.map(supervisionKey);
      ordered.splice(ordered.indexOf(sourceKey), 1);
      ordered.splice(ordered.indexOf(overKey), 0, sourceKey);
      const assignments = planPinnedReorder({
        orderedIds: ordered,
        keysById: new Map(
          siblings.map((t) => [
            supervisionKey(t),
            source.pinnedAt !== null ? t.pinOrderKey : t.activeOrderKey,
          ]),
        ),
        movedId: sourceKey,
      }).map((a) => ({ threadId: forest.byKey.get(a.id)!.id, orderKey: a.orderKey }));
      void commit({
        environmentId: source.environmentId,
        input: {
          commandId,
          threadId: source.id,
          parentThreadId: forest.byKey.get(parentKey)!.id,
          assignments,
        },
      });
      return true;
    }
    const target = resolveSidebarDropTarget(items, sourceKey, overKey);
    if (target)
      void commit({
        environmentId: source.environmentId,
        input: {
          commandId,
          threadId: source.id,
          parentThreadId: null,
          pinned: target.section === "pinned",
          section: target.section,
        },
      });
    return true;
  };
  return { intent, start, pointer, move, end };
}
