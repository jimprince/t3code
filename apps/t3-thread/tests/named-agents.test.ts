import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";

import {
  listNamedAgents,
  routeToNamedAgent,
  scaffoldAgentFolder,
  type NamedAgentClient,
  type NamedAgentSummary,
} from "../src/namedAgents.js";
import type { OrchestrationThreadShell, SavedEnvironment, StateFile } from "../src/types.js";

function environment(name: string): SavedEnvironment {
  return {
    name,
    httpBaseUrl: `http://${name}.test`,
    wsBaseUrl: `ws://${name}.test`,
    environmentId: `env-${name}`,
    label: name,
    serverVersion: "0.0.45",
    bearerToken: "token",
    expiresAt: "2099-01-01T00:00:00.000Z",
    pairedAt: "2026-10-01T00:00:00.000Z",
  };
}

function state(names: string[], agents: StateFile["agents"] = []): StateFile {
  return {
    version: 1,
    environments: names.map(environment),
    agents,
    subscriptions: [],
    notifications: [],
    queuedSends: [],
  };
}

const printer: NamedAgentSummary = {
  name: "printer",
  projectId: "project-printer",
  workspaceRoot: "/home/brad/.shared/agents/printer",
  scope: "The K1 printer",
  liveThreadId: null,
};

function fakeClients(
  byEnvironment: Record<string, { agents: NamedAgentSummary[]; threads?: unknown[] }>,
) {
  const resolved: Array<{ environment: string; name: string; message: string | undefined }> = [];
  const factory = (name: string): NamedAgentClient => ({
    async listNamedAgents() {
      const entry = byEnvironment[name];
      if (!entry) throw new Error("unreachable");
      return entry.agents;
    },
    async resolveNamedAgent(agentName, message) {
      resolved.push({ environment: name, name: agentName, message });
      return { threadId: "printer-1", started: true };
    },
    async listThreads() {
      return (byEnvironment[name]?.threads ?? []) as OrchestrationThreadShell[];
    },
  });
  return { factory, resolved };
}

describe("routeToNamedAgent", () => {
  it("starts a dormant agent with the message on the one environment that has it", async () => {
    const { factory, resolved } = fakeClients({
      mac: { agents: [] },
      "dev-vm": { agents: [printer] },
    });

    const routed = await routeToNamedAgent({
      state: state(["mac", "dev-vm"]),
      name: "printer",
      message: "Print bracket v3",
      clientFactory: factory,
    });

    expect(routed).toEqual({ environment: "dev-vm", threadId: "printer-1", started: true });
    expect(resolved).toEqual([
      { environment: "dev-vm", name: "printer", message: "Print bracket v3" },
    ]);
  });

  it("leaves saved aliases and thread UUIDs to the normal send path", async () => {
    const { factory, resolved } = fakeClients({ "dev-vm": { agents: [printer] } });
    const saved = state(
      ["dev-vm"],
      [
        {
          name: "printer",
          environment: "dev-vm",
          threadId: "worker-thread",
          projectId: "project-1",
          title: "Worker",
          createdAt: "2026-10-01T00:00:00.000Z",
          lastSeenAssistantMessageId: null,
        },
      ],
    );

    expect(
      await routeToNamedAgent({
        state: saved,
        name: "printer",
        message: "hi",
        clientFactory: factory,
      }),
    ).toBeNull();
    expect(
      await routeToNamedAgent({
        state: state(["dev-vm"]),
        name: "7d959cc2-0ba7-4857-93ff-8d0842cf70ad",
        message: "hi",
        clientFactory: factory,
      }),
    ).toBeNull();
    expect(resolved).toEqual([]);
  });

  it("refuses a name owned in more than one environment", async () => {
    const { factory } = fakeClients({
      mac: { agents: [printer] },
      "dev-vm": { agents: [printer] },
    });

    await expect(
      routeToNamedAgent({
        state: state(["mac", "dev-vm"]),
        name: "printer",
        message: "hi",
        clientFactory: factory,
      }),
    ).rejects.toThrow(/several paired environments: mac, dev-vm/);
  });
});

describe("listNamedAgents", () => {
  it("reports live status, dormant agents and unreachable environments", async () => {
    const { factory } = fakeClients({
      "dev-vm": {
        agents: [
          { ...printer, liveThreadId: "printer-1" },
          { ...printer, name: "deploy", liveThreadId: null },
        ],
        threads: [
          {
            id: "printer-1",
            archivedAt: null,
            hasActionableProposedPlan: false,
            session: { status: "running" },
            latestTurn: { state: "running" },
          },
        ],
      },
    });

    const result = await listNamedAgents({
      state: state(["dev-vm", "mac"]),
      clientFactory: factory,
    });

    expect(result.unreachableEnvironments).toEqual(["mac"]);
    expect(result.agents.map((agent) => [agent.name, agent.status])).toEqual([
      ["printer", "running"],
      ["deploy", "dormant"],
    ]);
  });
});

describe("scaffoldAgentFolder", () => {
  it("writes starter files once and never overwrites a charter", () => {
    const folder = NodePath.join(
      NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "agent-")),
      "printer",
    );
    const first = scaffoldAgentFolder({
      folder,
      name: "printer",
      scope: "The K1",
      environment: "dev-vm",
    });
    NodeFS.writeFileSync(NodePath.join(folder, "AGENT.md"), "edited charter");
    const second = scaffoldAgentFolder({
      folder,
      name: "printer",
      scope: "The K1",
      environment: "dev-vm",
    });

    expect(first.map((file) => NodePath.basename(file))).toEqual(["AGENT.md", "BRIEFING.md"]);
    expect(second).toEqual([]);
    expect(NodeFS.readFileSync(NodePath.join(folder, "AGENT.md"), "utf8")).toBe("edited charter");
  });
});
