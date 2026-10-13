import { planPinnedReorder } from "@t3tools/client-runtime/state/thread-sort";

/** A project row as the Projects list shows it, in displayed order. */
export interface ProjectMoveRow {
  readonly key: string;
  readonly pinned: boolean;
  readonly pinOrderKey: string | null;
}

/** One order write: pin a project at `orderKey`, or move an already pinned one there. */
export interface ProjectMoveWrite {
  readonly kind: "pin" | "reorder";
  readonly key: string;
  readonly orderKey: string;
}

/**
 * Plans moving one project to `toIndex` of the displayed Projects list. Pinned
 * projects lead in pin order and the rest sort by what needs Brad, so a move
 * only sticks inside the pinned run: the moved project and every project shown
 * above it join that run, and pinned projects below keep their place. The list
 * then reads exactly as dropped. `reservedKeys` are pin keys of pinned projects
 * not in `rows` (Quiet), which no write may reuse.
 */
export function planProjectMove(input: {
  readonly rows: ReadonlyArray<ProjectMoveRow>;
  readonly movedKey: string;
  readonly toIndex: number;
  readonly reservedKeys?: ReadonlyArray<string>;
}): { readonly order: ReadonlyArray<string>; readonly writes: ReadonlyArray<ProjectMoveWrite> } {
  const keys = input.rows.map((row) => row.key);
  const fromIndex = keys.indexOf(input.movedKey);
  const toIndex = Math.max(0, Math.min(input.toIndex, keys.length - 1));
  if (fromIndex === -1 || fromIndex === toIndex) return { order: keys, writes: [] };
  const order = [...keys];
  order.splice(fromIndex, 1);
  order.splice(toIndex, 0, input.movedKey);
  const rowByKey = new Map(input.rows.map((row) => [row.key, row]));
  const run = order.filter((key, index) => index <= toIndex || rowByKey.get(key)!.pinned);
  const keysById = new Map<string, string | null>(
    run.map((key) => {
      const row = rowByKey.get(key)!;
      return [key, row.pinned ? row.pinOrderKey : null];
    }),
  );
  (input.reservedKeys ?? []).forEach((orderKey, index) =>
    keysById.set(`\u0000reserved:${index}`, orderKey),
  );
  const writes = planPinnedReorder({ orderedIds: run, keysById, movedId: input.movedKey }).map(
    ({ id, orderKey }): ProjectMoveWrite => ({
      kind: rowByKey.get(id)!.pinned ? "reorder" : "pin",
      key: id,
      orderKey,
    }),
  );
  return { order, writes };
}
