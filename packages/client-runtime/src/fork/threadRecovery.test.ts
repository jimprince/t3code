import { describe, expect, it } from "vite-plus/test";
import { RunId } from "@t3tools/contracts";
import { isRecoveredRunSettled } from "./threadRecovery.ts";
const runId = RunId.make("recovery");
describe("recovered V2 runs", () => {
  it.each(["preparing", "queued", "starting", "running", "waiting"] as const)(
    "retains %s work",
    (status) => {
      expect(isRecoveredRunSettled({ runId, status }, null)).toBe(false);
    },
  );
  it.each(["completed", "interrupted", "failed", "cancelled", "rolled_back"] as const)(
    "releases %s work only after runtime ownership ends",
    (status) => {
      expect(isRecoveredRunSettled({ runId, status }, { activeRunId: runId })).toBe(false);
      expect(isRecoveredRunSettled({ runId, status }, null)).toBe(true);
    },
  );
  it("does not fabricate a settled run for a new thread", () => {
    expect(isRecoveredRunSettled(null, null)).toBe(false);
  });
});
