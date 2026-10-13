// @effect-diagnostics nodeBuiltinImport:off
// Standalone operator CLI journal; no Effect runtime.
import * as NodeFS from "node:fs";
import * as Schema from "effect/Schema";
import { RoutineKind, HarnessRoutineKindSetInput, type HarnessRoutine } from "@t3tools/contracts";

export const ClassificationPlan = Schema.Array(
  Schema.Struct({
    routineKey: Schema.String,
    name: Schema.String,
    kind: RoutineKind,
  }),
);
export type ClassificationPlan = typeof ClassificationPlan.Type;

type ClassificationApi = {
  snapshot: () => Promise<{ routines: readonly HarnessRoutine[] }>;
  set: (input: HarnessRoutineKindSetInput) => Promise<unknown>;
};

/** Dry-run is the default. Journal each original classification before its first write. */
export async function classifyRoutines(
  plan: ClassificationPlan,
  api: ClassificationApi,
  options: { apply: boolean; undoFile: string },
) {
  const snapshot = await api.snapshot();
  const byKey = new Map(snapshot.routines.map((row) => [row.key, row]));
  if (new Set(plan.map((row) => row.routineKey)).size !== plan.length)
    throw new Error("Duplicate routine key in plan.");
  // Validate the entire plan before the first write; feeds and legacy rows are not editable.
  for (const row of plan) {
    if (!byKey.has(row.routineKey)) throw new Error(`Routine not found: ${row.routineKey}`);
    if (!row.routineKey.includes(":automations:") && !row.routineKey.includes(":scheduled-task:"))
      throw new Error(`Routine is not editable: ${row.routineKey}`);
  }
  const table = plan.map((row) => ({
    routineKey: row.routineKey,
    name: row.name,
    before: byKey.get(row.routineKey)!.routineKind,
    source: byKey.get(row.routineKey)!.routineKindSource,
    proposed: row.kind,
    changed: false,
  }));
  if (!options.apply) return table;
  const undoSchema = Schema.Array(HarnessRoutineKindSetInput);
  const undo: Array<HarnessRoutineKindSetInput> = NodeFS.existsSync(options.undoFile)
    ? [
        ...Schema.decodeUnknownSync(undoSchema)(
          JSON.parse(NodeFS.readFileSync(options.undoFile, "utf8")),
        ),
      ]
    : [];
  for (const [index, row] of plan.entries()) {
    const previous = byKey.get(row.routineKey)!;
    if (previous.routineKindSource === "explicit" && previous.routineKind === row.kind) continue;
    if (!undo.some((entry) => entry.routineKey === row.routineKey)) {
      undo.push({
        routineKey: row.routineKey,
        kind: previous.routineKindSource === "explicit" ? previous.routineKind : null,
      });
      // Exclusive directory is supplied by the operator; retain this list after a partial failure.
      NodeFS.writeFileSync(options.undoFile, `${JSON.stringify(undo, null, 2)}\n`, { mode: 0o600 });
    }
    await api.set({ routineKey: row.routineKey, kind: row.kind });
    const readback = (await api.snapshot()).routines.find(
      (candidate) => candidate.key === row.routineKey,
    );
    if (readback?.routineKind !== row.kind || readback.routineKindSource !== "explicit")
      throw new Error(
        `Classification readback failed: ${row.routineKey}. Undo retained at ${options.undoFile}`,
      );
    table[index]!.changed = true;
  }
  return table;
}
