import { describe, expect, it } from "vite-plus/test";
import { RunId, ProviderInstanceId } from "@t3tools/contracts";
import { isLatestRunSettled, deriveCanInterruptRunningThread } from "./session-logic";

const runId = RunId.make("recovery-run");
describe("V2 recovery status", () => {
  it("uses terminal run status even when completedAt was not delivered", () => {
    expect(
      isLatestRunSettled(
        { runId, status: "interrupted", startedAt: null, completedAt: null },
        null,
      ),
    ).toBe(true);
  });
  it("keeps runtime-owned terminal work unsettled", () => {
    expect(
      isLatestRunSettled(
        { runId, status: "failed", startedAt: null, completedAt: null },
        { status: "running", activeRunId: runId },
      ),
    ).toBe(false);
  });
  it.each(["preparing", "starting"] as const)("allows Stop while %s", (status) => {
    expect(
      deriveCanInterruptRunningThread(true, {
        status,
        activeRunId: runId,
        activityStartedAt: null,
        updatedAt: "2026-10-05T00:00:00Z",
        lastError: null,
        providerInstanceId: ProviderInstanceId.make("codex"),
        providerName: null,
      }),
    ).toBe(true);
  });
});
