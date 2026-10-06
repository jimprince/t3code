import { expect, it } from "vite-plus/test";
import { AsyncResult } from "effect/unstable/reactivity";
import { supervisionMetadataReady } from "./forkNestingQuery.ts";

it("requires a connected host and a completed successful sidecar load, including an empty response", () => {
  const loaded = AsyncResult.success([]);
  expect(supervisionMetadataReady(true, loaded)).toBe(true);
  expect(supervisionMetadataReady(false, loaded)).toBe(false);
  expect(supervisionMetadataReady(true, AsyncResult.initial())).toBe(false);
  expect(supervisionMetadataReady(true, AsyncResult.waiting(loaded))).toBe(false);
});
