import { Schema } from "effect";
import { describe, expect, it } from "vite-plus/test";

import { OrchestrationShellStreamItem } from "../src/vendor/t3contracts/orchestration.js";
import { ServerProvider } from "../src/vendor/t3contracts/server.js";

const CUSTOM_INSTANCE_ID = "claudeAgent_ucalgary";

const decodeShellStreamItem = Schema.decodeUnknownPromise(OrchestrationShellStreamItem);
const decodeServerProvider = Schema.decodeUnknownPromise(ServerProvider);

function shellThread(instanceId: string) {
  return {
    id: "thread-1",
    projectId: "project-1",
    title: "custom instance thread",
    modelSelection: { instanceId, model: "claude-opus-5" },
    runtimeMode: "full-access",
    branch: null,
    worktreePath: null,
    latestTurn: null,
    createdAt: "2026-09-03T00:00:00.000Z",
    updatedAt: "2026-09-03T00:00:00.000Z",
    session: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
  };
}

// Custom provider instance ids (`claudeAgent_ucalgary`) are first-class in T3 Code
// and must not be rejected by the operator CLI's snapshot contracts.
describe("custom provider instance ids", () => {
  it("decodes a shell snapshot thread selecting a custom provider instance", async () => {
    const item = await decodeShellStreamItem({
      kind: "snapshot",
      snapshot: {
        snapshotSequence: 0,
        projects: [],
        threads: [shellThread(CUSTOM_INSTANCE_ID)],
        updatedAt: "2026-09-03T00:00:00.000Z",
      },
    });

    expect(item.kind).toBe("snapshot");
    if (item.kind !== "snapshot") {
      throw new Error("Expected a snapshot stream item.");
    }
    expect(item.snapshot.threads[0]?.modelSelection.provider).toBe(CUSTOM_INSTANCE_ID);
  });

  it("decodes a server provider advertising a custom instance id", async () => {
    const provider = await decodeServerProvider({
      provider: "claudeAgent",
      instanceId: CUSTOM_INSTANCE_ID,
      driver: "claudeAgent",
      enabled: true,
      installed: true,
      version: "1.2.3",
      status: "ready",
      auth: { status: "authenticated" },
      checkedAt: "2026-09-03T00:00:00.000Z",
      models: [],
    });

    expect(provider.instanceId).toBe(CUSTOM_INSTANCE_ID);
  });
});
