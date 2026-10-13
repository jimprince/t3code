import * as Schema from "effect/Schema";

/** Explicit classification; an absent value follows the owner thread's purpose. */
export const RoutineKind = Schema.Literals(["check", "project", "agent-wake"]);
export type RoutineKind = typeof RoutineKind.Type;
export const RoutineKindSource = Schema.Literals(["explicit", "default"]);
export type RoutineKindSource = typeof RoutineKindSource.Type;
/** Stored beside scheduled timing in the existing schedule_json payload. */
export const RoutineKindMetadata = Schema.Struct({ routineKind: Schema.optionalKey(RoutineKind) });
