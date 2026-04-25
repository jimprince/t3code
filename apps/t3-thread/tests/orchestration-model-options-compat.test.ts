import { describe, expect, it } from "vitest";
import { Schema } from "effect";

import { OrchestrationShellStreamItem } from "../src/vendor/t3contracts/orchestration.js";

const decodeShellStreamItem = Schema.decodeUnknownSync(OrchestrationShellStreamItem);

describe("orchestration model option compatibility", () => {
  it("decodes legacy array-shaped model options in shell snapshots", () => {
    const parsed = decodeShellStreamItem({
      kind: "snapshot",
      snapshot: {
        snapshotSequence: 1,
        projects: [],
        threads: [
          {
            id: "thread-1",
            projectId: "project-1",
            title: "Thread title",
            modelSelection: {
              provider: "codex",
              model: "gpt-5.4",
              options: [{ id: "reasoningEffort", value: "high" }],
            },
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            latestTurn: null,
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
            archivedAt: null,
            session: null,
            latestUserMessageAt: null,
            hasPendingApprovals: false,
            hasPendingUserInput: false,
            hasActionableProposedPlan: false,
          },
        ],
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    });

    expect(parsed.kind).toBe("snapshot");
    if (parsed.kind !== "snapshot") {
      throw new Error("Expected snapshot");
    }
    expect(parsed.snapshot.threads[0]?.modelSelection.options?.reasoningEffort).toBe("high");
  });
});
