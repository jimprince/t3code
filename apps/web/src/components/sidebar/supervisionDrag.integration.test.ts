import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { supervisionForest } from "@t3tools/client-runtime/state/fork-nesting";
import { expect, it } from "vite-plus/test";
import { supervisionDragIntent, canSupervise } from "./supervisionDragIntent";
import { makeThreadFixture } from "../../test-fixtures";

it("requires explicit nesting intent and rejects cycles", () => {
  const threads = ["a", "b"].map((id) =>
    makeThreadFixture({ environmentId: EnvironmentId.make("env"), id: ThreadId.make(id) }),
  );
  const forest = supervisionForest(threads);
  const input = { sourceKey: "env:a", overKey: "env:b", forest };
  expect(supervisionDragIntent({ ...input, previous: { kind: "reorder" }, dx: 11 })).toEqual({
    kind: "reorder",
  });
  const nested = supervisionDragIntent({ ...input, previous: { kind: "reorder" }, dx: 12 });
  expect(nested).toEqual({ kind: "nest", parentKey: "env:b" });
  expect(supervisionDragIntent({ ...input, previous: nested, dx: 7 })).toEqual(nested);
  expect(supervisionDragIntent({ ...input, previous: nested, dx: 5 })).toEqual({ kind: "reorder" });
  expect(canSupervise(forest, "env:a", "env:a")).toBe(false);
  expect(canSupervise(forest, "env:a", "missing")).toBe(false);
});
