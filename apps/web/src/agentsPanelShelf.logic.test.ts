import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import type {
  AgentPanelWorkflowGroup,
  RuntimeSubagent,
} from "@t3tools/client-runtime/state/subagentRuntime";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { shelveAgentsPanelEntries } from "./agentsPanelShelf.logic";

const environmentId = EnvironmentId.make("env-a");

function thread(
  id: string,
  overrides: Partial<
    Pick<
      EnvironmentThreadShell,
      "createdAt" | "settledOverride" | "settledAt" | "updatedAt" | "latestUserMessageAt"
    >
  > = {},
): EnvironmentThreadShell {
  return {
    id: ThreadId.make(id),
    environmentId,
    createdAt: "2026-09-20T00:00:00.000Z",
    updatedAt: "2026-09-20T00:00:00.000Z",
    latestUserMessageAt: null,
    latestTurn: null,
    settledOverride: null,
    settledAt: null,
    ...overrides,
  } as unknown as EnvironmentThreadShell;
}

function agent(
  id: string,
  overrides: Partial<
    Pick<RuntimeSubagent, "status" | "firstSeenAt" | "completedAt" | "updatedAt">
  > = {},
): RuntimeSubagent {
  return {
    id,
    status: "running",
    firstSeenAt: "2026-09-20T00:00:00.000Z",
    completedAt: null,
    updatedAt: "2026-09-20T00:00:00.000Z",
    ...overrides,
  } as unknown as RuntimeSubagent;
}

function workflow(id: string, status: RuntimeSubagent["status"]): AgentPanelWorkflowGroup {
  return {
    workflow: agent(id, { status, firstSeenAt: "2026-09-20T01:00:00.000Z" }),
    phases: [],
    unphasedMembers: [],
  };
}

const keys = (entries: ReadonlyArray<{ readonly key: string }>) =>
  entries.map((entry) => entry.key);

describe("shelveAgentsPanelEntries", () => {
  it("shelves server-settled threads and finished spawns but keeps idle spawns active", () => {
    const { active, settled } = shelveAgentsPanelEntries({
      threads: [
        thread("child-live"),
        thread("child-settled", {
          settledOverride: "settled",
          settledAt: "2026-09-25T00:00:00.000Z",
        }),
        // A user un-settle pins the thread active; it must not be shelved.
        thread("child-pinned-active", { settledOverride: "active" }),
      ],
      workflows: [workflow("run-live", "running"), workflow("run-done", "completed")],
      directAgents: [
        agent("spawn-running"),
        agent("spawn-idle", { status: "idle" }),
        agent("spawn-completed", { status: "completed" }),
        agent("spawn-failed", { status: "failed" }),
        agent("spawn-stopped", { status: "interrupted" }),
      ],
      keepActiveKeys: new Set(),
    });

    expect(keys(active).toSorted()).toEqual(
      [
        "agent:spawn-idle",
        "agent:spawn-running",
        `thread:${environmentId}:child-live`,
        `thread:${environmentId}:child-pinned-active`,
        "workflow:run-live",
      ].toSorted(),
    );
    expect(keys(settled).toSorted()).toEqual(
      [
        "agent:spawn-completed",
        "agent:spawn-failed",
        "agent:spawn-stopped",
        `thread:${environmentId}:child-settled`,
        "workflow:run-done",
      ].toSorted(),
    );
  });

  it("interleaves threads and spawns in start order", () => {
    const { active } = shelveAgentsPanelEntries({
      threads: [
        thread("thread-late", { createdAt: "2026-09-20T03:00:00.000Z" }),
        thread("thread-early", { createdAt: "2026-09-20T01:00:00.000Z" }),
      ],
      workflows: [],
      directAgents: [agent("spawn-middle", { firstSeenAt: "2026-09-20T02:00:00.000Z" })],
      keepActiveKeys: new Set(),
    });

    expect(keys(active)).toEqual([
      `thread:${environmentId}:thread-early`,
      "agent:spawn-middle",
      `thread:${environmentId}:thread-late`,
    ]);
  });

  it("lists the most recently finished settled rows first", () => {
    const { settled } = shelveAgentsPanelEntries({
      threads: [
        thread("thread-settled", {
          settledOverride: "settled",
          settledAt: "2026-09-22T00:00:00.000Z",
        }),
      ],
      workflows: [],
      directAgents: [
        agent("spawn-old", { status: "completed", completedAt: "2026-09-21T00:00:00.000Z" }),
        agent("spawn-new", { status: "completed", completedAt: "2026-09-23T00:00:00.000Z" }),
      ],
      keepActiveKeys: new Set(),
    });

    expect(keys(settled)).toEqual([
      "agent:spawn-new",
      `thread:${environmentId}:thread-settled`,
      "agent:spawn-old",
    ]);
  });

  it("keeps rows the viewer saw active in place after they settle", () => {
    const { active, settled } = shelveAgentsPanelEntries({
      threads: [thread("child", { settledOverride: "settled" })],
      workflows: [],
      directAgents: [agent("spawn", { status: "completed" })],
      keepActiveKeys: new Set(["agent:spawn"]),
    });

    expect(keys(active)).toEqual(["agent:spawn"]);
    expect(keys(settled)).toEqual([`thread:${environmentId}:child`]);
  });
});
