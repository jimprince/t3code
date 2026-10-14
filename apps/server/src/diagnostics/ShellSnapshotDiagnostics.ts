import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

/** Static service/RPC labels only; never thread IDs, credentials, paths or client input. */
export class ShellSnapshotCaller extends Context.Reference<string>(
  "t3/diagnostics/ShellSnapshotCaller",
  { defaultValue: () => "unattributed" },
) {}

export interface ShellSnapshotCounts {
  readonly requests: number;
  readonly fullBuilds: number;
  readonly cacheHits: number;
}

export class ShellSnapshotDiagnostics extends Context.Service<
  ShellSnapshotDiagnostics,
  {
    readonly record: (kind: keyof ShellSnapshotCounts) => Effect.Effect<void>;
    /** Cumulative since service startup; reads return detached values. */
    readonly read: Effect.Effect<Readonly<Record<string, ShellSnapshotCounts>>>;
  }
>()("t3/diagnostics/ShellSnapshotDiagnostics") {}

const make = Effect.sync(() => {
  const counters = new Map<string, ShellSnapshotCounts>();
  const record = (kind: keyof ShellSnapshotCounts) =>
    Effect.gen(function* () {
      const label = yield* ShellSnapshotCaller;
      // An unexpected caller cannot grow the diagnostics indefinitely.
      const key = counters.has(label) || counters.size < 128 ? label : "other";
      const counts = counters.get(key) ?? { requests: 0, fullBuilds: 0, cacheHits: 0 };
      counters.set(key, { ...counts, [kind]: counts[kind] + 1 });
    });
  return ShellSnapshotDiagnostics.of({
    record,
    read: Effect.sync(() =>
      Object.fromEntries([...counters].map(([caller, counts]) => [caller, { ...counts }])),
    ),
  });
});

export const layer = Layer.effect(ShellSnapshotDiagnostics, make);

/** Keep the transport's method label; name direct service/reactor calls otherwise. */
export const withCaller =
  (caller: string) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.flatMap(ShellSnapshotCaller, (existing) =>
      effect.pipe(
        Effect.provideService(ShellSnapshotCaller, existing === "unattributed" ? caller : existing),
      ),
    );
