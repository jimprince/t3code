import {
  HarnessReadError,
  HarnessRoutineKindSetInput,
  type HarnessRoutineKindSetResult,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { ServerEnvironmentIdentity } from "../environment/ServerEnvironment.ts";

const decodeInput = Schema.decodeUnknownEffect(HarnessRoutineKindSetInput);
const isReadError = Schema.is(HarnessReadError);

/** Patch only classification: never reschedule, dispatch, or rewrite a stale definition. */
export class RoutineKindService extends Context.Service<
  RoutineKindService,
  {
    readonly environmentId: string;
    readonly set: (
      input: HarnessRoutineKindSetInput,
    ) => Effect.Effect<HarnessRoutineKindSetResult, HarnessReadError>;
  }
>()("t3/harness/RoutineKindService") {}

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const environmentId = yield* (yield* ServerEnvironmentIdentity).getEnvironmentId;
  return RoutineKindService.of({
    environmentId,
    set: (input) =>
      Effect.gen(function* () {
        const { routineKey, kind } = yield* decodeInput(input);
        const automationPrefix = `${environmentId}:automations:`;
        const taskPrefix = `${environmentId}:scheduled-task:`;
        // Environment-local exact keys; ids may themselves contain colons.
        const automation = routineKey.startsWith(automationPrefix);
        if (!automation && !routineKey.startsWith(taskPrefix))
          return yield* new HarnessReadError({
            message: "This routine is not editable in this environment.",
          });
        const id = routineKey.slice((automation ? automationPrefix : taskPrefix).length);
        const rows = automation
          ? yield* sql<{ id: string }>`UPDATE automations SET automation_json = ${
              kind === null
                ? sql`json_remove(automation_json, '$.routineKind')`
                : sql`json_set(automation_json, '$.routineKind', ${kind})`
            }
              WHERE automation_id = ${id} AND deleted_at IS NULL RETURNING automation_id AS id`
          : yield* sql<{ id: string }>`UPDATE scheduled_tasks SET schedule_json = ${
              kind === null
                ? sql`json_remove(schedule_json, '$.routineKind')`
                : sql`json_set(schedule_json, '$.routineKind', ${kind})`
            }
              WHERE task_id = ${id} RETURNING task_id AS id`;
        if (rows.length !== 1)
          return yield* new HarnessReadError({ message: "Routine not found." });
        return {
          routineKey,
          kind,
          source: kind === null ? ("default" as const) : ("explicit" as const),
        };
      }).pipe(
        Effect.mapError((error) =>
          isReadError(error)
            ? error
            : new HarnessReadError({ message: "Routine classification could not be saved." }),
        ),
      ),
  });
});
export const layer = Layer.effect(RoutineKindService, make);
