import { describe, expect, it } from "vite-plus/test";
import type { OrchestrationV2ThreadProjection } from "@t3tools/contracts";
import { projectionHasWork } from "../src/v2/workState.js";
import { planWorktreeGc } from "../src/worktreeGc.js";

const base = {
  thread: { activeProviderThreadId: null },
  runs: [],
  providerThreads: [],
  turnItems: [],
  runtimeRequests: [],
} as unknown as OrchestrationV2ThreadProjection;
describe("V2 worktree eligibility", () => {
  it.each(["preparing", "queued", "starting", "running", "waiting"] as const)(
    "retains an archived checkout with a %s run",
    async (status) => {
      const projection = {
        ...base,
        runs: [{ id: "run", ordinal: 1, status }],
      } as unknown as OrchestrationV2ThreadProjection;
      const plan = await planWorktreeGc({
        threads: [
          {
            id: "old",
            worktreePath: "/worktrees/old",
            archivedAt: "2026-08-01T00:00:00Z",
            workActive: projectionHasWork(projection),
          },
        ],
        inspect: async () => ({ kind: "clean" }),
        now: new Date("2026-10-05T00:00:00Z"),
      });
      expect(plan.removable).toEqual([]);
      expect(plan.retained[0]?.reason).toBe("active-turn");
    },
  );
  it("retains a pending request even after its run ends", () => {
    expect(
      projectionHasWork({
        ...base,
        runtimeRequests: [{ status: "pending" }],
      } as unknown as OrchestrationV2ThreadProjection),
    ).toBe(true);
  });
  it("retains a background command after root completion", () => {
    const projection = {
      ...base,
      runs: [{ id: "run", ordinal: 1, status: "completed" }],
      turnItems: [
        {
          id: "command",
          type: "command_execution",
          status: "running",
          runId: "run",
          title: "dev server",
          startedAt: null,
        },
      ],
    } as unknown as OrchestrationV2ThreadProjection;
    expect(projectionHasWork(projection)).toBe(true);
  });
  it("allows a checkout with completed resources", () => {
    expect(
      projectionHasWork({
        ...base,
        runs: [{ id: "run", ordinal: 1, status: "completed" }],
      } as unknown as OrchestrationV2ThreadProjection),
    ).toBe(false);
  });
});
