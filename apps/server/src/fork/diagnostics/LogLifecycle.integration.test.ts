// @effect-diagnostics nodeBuiltinImport:off
import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";
import { expect } from "vite-plus/test";
import { it } from "@effect/vitest";
import * as TestClock from "effect/testing/TestClock";
import { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { makeEventNdjsonLogStore } from "../../provider/Layers/EventNdjsonLogger.ts";
import * as ProviderEventLoggers from "../../provider/Layers/ProviderEventLoggers.ts";
import { releaseThreadLogs } from "./LogLifecycle.ts";

it.effect("flushes final lifecycle frames before evicting a stopped or archived thread sink", () =>
  Effect.gen(function* () {
    const directory = FS.mkdtempSync(Path.join(OS.tmpdir(), "fork-log-lifecycle-"));
    try {
      yield* Effect.gen(function* () {
        yield* TestClock.setTime(1_800_000_000_000);
        const store = yield* makeEventNdjsonLogStore(Path.join(directory, "provider.ndjson"), {
          batchWindowMs: 0,
          maxAgeMs: 1,
          retentionCheckIntervalMs: 1,
        });
        const native = store.logger("native");
        const canonical = store.logger("canonical");
        for (const status of ["stopped", "archived"]) {
          const id = ThreadId.make(`thread-${status}`);
          yield* native.write({ type: "native-final", status }, id);
          yield* canonical.write({ type: "provider-session.updated", status }, id);
          yield* releaseThreadLogs([id]).pipe(
            Effect.provideService(ProviderEventLoggers.ProviderEventLoggers, { native, canonical }),
          );
          const path = Path.join(directory, `provider.${id}.log`);
          expect(FS.readFileSync(path, "utf8")).toContain("native-final");
          expect(FS.readFileSync(path, "utf8")).toContain(status);
          yield* TestClock.adjust("2 millis");
          yield* canonical.write({ type: "retention-trigger" }, ThreadId.make(`other-${status}`));
          expect(FS.existsSync(path)).toBe(false);
          // A later explicit turn can acquire a writer again after retention.
          yield* canonical.write({ type: "turn.started" }, id);
          yield* releaseThreadLogs([id]).pipe(
            Effect.provideService(ProviderEventLoggers.ProviderEventLoggers, { native, canonical }),
          );
          expect(FS.readFileSync(path, "utf8")).toContain("turn.started");
        }
        yield* store.close();
      }).pipe(Effect.scoped);
    } finally {
      FS.rmSync(directory, { recursive: true, force: true });
    }
  }),
);
