import { expect, it } from "vite-plus/test";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { EnvironmentId, OrchestrationV2ThreadShell, ThreadId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { createHostThreadIdsKey, supervisionMetadataReady } from "./forkNestingQuery.ts";
import { presentThreadShell, type EnvironmentThreadShell } from "./models.ts";
import { v2ThreadShell } from "./orchestrationV2TestFixtures.ts";

it("requires a connected host and a completed successful sidecar load, including an empty response", () => {
  const loaded = AsyncResult.success([]);
  expect(supervisionMetadataReady(true, loaded)).toBe(true);
  expect(supervisionMetadataReady(false, loaded)).toBe(false);
  expect(supervisionMetadataReady(true, AsyncResult.initial())).toBe(false);
  expect(supervisionMetadataReady(true, AsyncResult.waiting(loaded))).toBe(false);
});

it("keeps the last good sidecar through a failed refresh, but a host that never loaded stays not ready", () => {
  const loaded = AsyncResult.success([]);
  const failedRefresh = AsyncResult.failure(Cause.fail("offline"), {
    previousSuccess: Option.some(loaded),
  });
  expect(supervisionMetadataReady(true, failedRefresh)).toBe(true);
  expect(supervisionMetadataReady(true, AsyncResult.failure(Cause.fail("offline")))).toBe(false);
});

it("refreshes the sidecar on a claim and on a sidecar write, never on shell churn", () => {
  const host = EnvironmentId.make("host");
  const other = EnvironmentId.make("other");
  const shell = (
    id: string,
    environmentId: EnvironmentId,
    updatedAt: string,
    forkMetadataRevision?: number,
  ) =>
    ({
      id,
      environmentId,
      updatedAt,
      ...(forkMetadataRevision === undefined ? {} : { forkMetadataRevision }),
    }) as unknown as EnvironmentThreadShell;
  const shells = Atom.make<ReadonlyArray<EnvironmentThreadShell>>([
    shell("a", host, "1"),
    shell("c", other, "1"),
  ]);
  const registry = AtomRegistry.make();
  const key = createHostThreadIdsKey(shells)(host);
  let emissions = 0;
  const cancel = registry.subscribe(key, () => (emissions += 1));
  expect(registry.get(key)).toBe("a:0");
  emissions = 0;

  // An agent claims a worker: the new id refreshes the query once.
  registry.set(shells, [shell("a", host, "2"), shell("w", host, "2"), shell("c", other, "2")]);
  expect(registry.get(key)).toBe("a:0\nw:0");
  expect(emissions).toBe(1);

  // Status and timestamp churn, here or on another host, does not refresh it.
  registry.set(shells, [shell("a", host, "3"), shell("w", host, "3"), shell("c", other, "9")]);
  registry.set(shells, [shell("a", host, "4"), shell("w", host, "5"), shell("c", other, "10")]);
  expect(emissions).toBe(1);

  // The CLI nests the worker later: the same ids with a bumped revision refresh it once.
  registry.set(shells, [shell("a", host, "6"), shell("w", host, "6", 1), shell("c", other, "10")]);
  expect(registry.get(key)).toBe("a:0\nw:1");
  expect(emissions).toBe(2);

  // Churn after the write is quiet again, and a second write refreshes again.
  registry.set(shells, [shell("a", host, "7"), shell("w", host, "8", 1), shell("c", other, "11")]);
  expect(emissions).toBe(2);
  registry.set(shells, [shell("a", host, "7"), shell("w", host, "9", 2), shell("c", other, "11")]);
  expect(emissions).toBe(3);
  cancel();
});

it("falls back to the host id set when the server predates forkMetadataRevision", () => {
  const host = EnvironmentId.make("host");
  const wire = Schema.decodeUnknownSync(OrchestrationV2ThreadShell)(
    Schema.encodeSync(OrchestrationV2ThreadShell)(v2ThreadShell),
  );
  expect(wire.forkMetadataRevision).toBeUndefined();
  const shell = (id: string, title: string) =>
    presentThreadShell(host, { ...wire, id: ThreadId.make(id), title });
  expect("forkMetadataRevision" in shell("a", "1")).toBe(false);
  const shells = Atom.make<ReadonlyArray<EnvironmentThreadShell>>([shell("a", "1")]);
  const registry = AtomRegistry.make();
  const key = createHostThreadIdsKey(shells)(host);
  let emissions = 0;
  const cancel = registry.subscribe(key, () => (emissions += 1));
  expect(registry.get(key)).toBe("a:0");
  emissions = 0;

  registry.set(shells, [shell("a", "2"), shell("w", "2")]);
  expect(emissions).toBe(1);
  registry.set(shells, [shell("a", "3"), shell("w", "4")]);
  expect(emissions).toBe(1);
  cancel();
});
