// @effect-diagnostics nodeBuiltinImport:off
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import * as ProcessRows from "./forkProcessRows.ts";
export class RecoveryProcessAccess extends Context.Service<
  RecoveryProcessAccess,
  {
    readonly read: Effect.Effect<ReadonlyArray<ProcessRows.ProcessRow>>;
    readonly signal: (row: ProcessRows.ProcessRow) => Effect.Effect<boolean>;
  }
>()("t3/diagnostics/RecoveryProcessAccess") {}
export const layer = Layer.effect(
  RecoveryProcessAccess,
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    return RecoveryProcessAccess.of({
      read: ProcessRows.readProcessRows.pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.orElseSucceed(() => []),
      ),
      signal: (row) =>
        Effect.sync(() => {
          if (
            row.pid <= 1 ||
            row.pid === process.pid ||
            row.uid !== process.getuid?.() ||
            row.startTimeMs === null
          )
            return false;
          try {
            process.kill(row.pid, "SIGINT");
            return true;
          } catch {
            return false;
          }
        }),
    });
  }),
);
