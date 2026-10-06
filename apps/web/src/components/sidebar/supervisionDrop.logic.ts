import type { CommandId, EnvironmentId, SupervisionDrop } from "@t3tools/contracts";
import {
  supervisionThreadKey,
  type supervisionForest,
} from "@t3tools/client-runtime/state/fork-nesting";
import { planPinnedReorder } from "@t3tools/client-runtime/state/thread-sort";
import { resolveSidebarDropTarget, type SidebarListItem } from "../Sidebar.logic";
import { directSiblingBucket, type SupervisionDragIntent } from "./supervisionDragIntent";

export interface SupervisionDropCommand {
  readonly environmentId: EnvironmentId;
  readonly input: SupervisionDrop;
}

/**
 * `handled: false` leaves the drop to the sidebar's ordinary reorder. A handled
 * drop may carry no command when there is nothing valid to send.
 */
export function planSupervisionDrop(input: {
  forest: ReturnType<typeof supervisionForest>;
  items: ReadonlyArray<SidebarListItem>;
  intent: SupervisionDragIntent;
  sourceKey: string;
  overKey: string | null;
  commandId: CommandId;
}): { readonly handled: boolean; readonly command?: SupervisionDropCommand } {
  const { forest, intent, sourceKey, overKey, commandId } = input;
  const source = forest.byKey.get(sourceKey);
  if (!source || overKey === null) return { handled: false };
  if (intent.kind === "nest") {
    const parent = forest.byKey.get(intent.parentKey);
    if (!parent) return { handled: true };
    return {
      handled: true,
      command: {
        environmentId: source.environmentId,
        input: { commandId, threadId: source.id, parentThreadId: parent.id },
      },
    };
  }
  const parentKey = forest.parentByKey.get(sourceKey);
  if (parentKey === undefined) return { handled: false };
  const over = forest.byKey.get(overKey);
  const siblings = directSiblingBucket(forest, source);
  if (over && siblings.includes(over)) {
    const ordered = siblings.map(supervisionThreadKey);
    ordered.splice(ordered.indexOf(sourceKey), 1);
    ordered.splice(ordered.indexOf(overKey), 0, sourceKey);
    const assignments = planPinnedReorder({
      orderedIds: ordered,
      keysById: new Map(
        siblings.map((t) => [
          supervisionThreadKey(t),
          source.pinnedAt !== null ? t.pinOrderKey : t.activeOrderKey,
        ]),
      ),
      movedId: sourceKey,
    }).map((a) => ({ threadId: forest.byKey.get(a.id)!.id, orderKey: a.orderKey }));
    return {
      handled: true,
      command: {
        environmentId: source.environmentId,
        input: {
          commandId,
          threadId: source.id,
          parentThreadId: forest.byKey.get(parentKey)!.id,
          assignments,
        },
      },
    };
  }
  // Dropped beside anything that is not a sibling: the child leaves its parent
  // and lands where the sidebar would have put a top-level row.
  const target = resolveSidebarDropTarget(input.items, sourceKey, overKey);
  if (!target) return { handled: true };
  return {
    handled: true,
    command: {
      environmentId: source.environmentId,
      input: {
        commandId,
        threadId: source.id,
        parentThreadId: null,
        pinned: target.section === "pinned",
        section: target.section,
      },
    },
  };
}
