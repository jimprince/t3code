import { describe, expect, it } from "vite-plus/test";
import { readSavedStatus } from "../src/saved-status.js";
import type { SavedAgent, StateFile, OrchestrationThread } from "../src/types.js";

const agent: SavedAgent = {
  name: "stale",
  environment: "test",
  threadId: "missing",
  projectId: "project",
  title: "Old worker",
  createdAt: "2026-01-01",
  lastSeenAssistantMessageId: null,
};
const state: StateFile = {
  version: 1,
  agents: [agent],
  subscriptions: [],
  notifications: [],
  queuedSends: [],
  environments: [
    {
      name: "test",
      httpBaseUrl: "http://test",
      wsBaseUrl: "ws://test",
      environmentId: "test",
      label: "test",
      serverVersion: "test",
      bearerToken: "test",
      expiresAt: "2099-01-01",
      pairedAt: "2026-01-01",
    },
  ],
};

describe("saved status listing", () => {
  it("reports a missing mapping and keeps the healthy summary", async () => {
    const factory = () => ({
      async findThread(id: string) {
        if (id === "missing") throw new Error("Thread missing was not found");
        return {
          id,
          title: "Healthy",
          projectId: "project",
          archivedAt: null,
          latestTurn: null,
          session: null,
          proposedPlans: [],
          messages: [],
        } as unknown as OrchestrationThread;
      },
      async sendMessage() {},
    });
    const lines = await Promise.all(
      [agent, { ...agent, name: "healthy", threadId: "healthy" }].map((saved) =>
        readSavedStatus(saved, state, factory),
      ),
    );
    expect(lines[0]).toContain("stale [missing]");
    expect(lines[0]).toContain("t3-thread forget stale");
    expect(lines[1]).toContain("healthy [idle]");
  });
  it("preserves authentication and transport failures", async () => {
    await expect(
      readSavedStatus(agent, state, () => ({
        async findThread() {
          throw new Error("unauthorized");
        },
        async sendMessage() {},
      })),
    ).rejects.toThrow("unauthorized");
  });
});
