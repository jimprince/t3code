import { expect, it } from "vite-plus/test";
import { AsyncResult, Atom, AtomRegistry } from "effect/unstable/reactivity";
import { EnvironmentId } from "@t3tools/contracts";
import { createHostThreadIdsKey, supervisionMetadataReady } from "./forkNestingQuery.ts";
import type { EnvironmentThreadShell } from "./models.ts";

it("requires a connected host and a completed successful sidecar load, including an empty response", () => {
  const loaded = AsyncResult.success([]);
  expect(supervisionMetadataReady(true, loaded)).toBe(true);
  expect(supervisionMetadataReady(false, loaded)).toBe(false);
  expect(supervisionMetadataReady(true, AsyncResult.initial())).toBe(false);
  expect(supervisionMetadataReady(true, AsyncResult.waiting(loaded))).toBe(false);
});

it("refreshes the sidecar only when a host's thread ids change, not on shell churn", () => {
  const host = EnvironmentId.make("host");
  const other = EnvironmentId.make("other");
  const shell = (id: string, environmentId: EnvironmentId, updatedAt: string) =>
    ({ id, environmentId, updatedAt }) as unknown as EnvironmentThreadShell;
  const shells = Atom.make<ReadonlyArray<EnvironmentThreadShell>>([
    shell("a", host, "1"),
    shell("b", host, "1"),
    shell("c", other, "1"),
  ]);
  const registry = AtomRegistry.make();
  const key = createHostThreadIdsKey(shells)(host);
  let emissions = 0;
  const cancel = registry.subscribe(key, () => (emissions += 1));
  expect(registry.get(key)).toBe("a\nb");
  emissions = 0;

  registry.set(shells, [shell("a", host, "2"), shell("b", host, "2"), shell("c", other, "2")]);
  registry.set(shells, [shell("a", host, "3"), shell("b", host, "3"), shell("c", other, "9")]);
  expect(emissions).toBe(0);

  registry.set(shells, [shell("a", host, "3"), shell("b", host, "3"), shell("d", host, "4")]);
  expect(registry.get(key)).toBe("a\nb\nd");
  expect(emissions).toBe(1);
  cancel();
});
