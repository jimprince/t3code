import { describe, expect, it, vi } from "vite-plus/test";

import {
  assertThreadSearchUuid,
  assertSavedAgentCapability,
  isRawThreadUuid,
  resolveAgentTarget,
  resolveSavedAgentTarget,
  toThreadSearchResult,
} from "../src/agent-targets.js";
import type {
  OrchestrationThreadShell,
  SavedAgent,
  SavedEnvironment,
  StateFile,
} from "../src/types.js";

function makeAgent(overrides: Partial<SavedAgent> = {}): SavedAgent {
  return {
    name: "worker-a",
    environment: "local-mbp",
    threadId: "11111111-1111-4111-8111-111111111111",
    projectId: "project-1",
    title: "Worker A",
    createdAt: "2026-06-17T00:00:00.000Z",
    lastSeenAssistantMessageId: null,
    ...overrides,
  };
}

function makeEnvironment(overrides: Partial<SavedEnvironment> = {}): SavedEnvironment {
  return {
    name: "local-mbp",
    httpBaseUrl: "http://127.0.0.1:3773",
    wsBaseUrl: "ws://127.0.0.1:3773",
    environmentId: "env-local",
    label: "Brad Local",
    serverVersion: "0.1.0",
    bearerToken: "token",
    expiresAt: "2026-06-18T00:00:00.000Z",
    pairedAt: "2026-06-17T00:00:00.000Z",
    ...overrides,
  };
}

function makeThread(overrides: Partial<OrchestrationThreadShell> = {}): OrchestrationThreadShell {
  return {
    id: "22222222-2222-4222-8222-222222222222",
    projectId: "project-2",
    title: "Unsaved Worker",
    modelSelection: {
      provider: "codex",
      model: "gpt-5.4",
    },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    latestTurn: null,
    createdAt: "2026-06-17T00:00:00.000Z",
    updatedAt: "2026-06-17T00:00:00.000Z",
    archivedAt: null,
    session: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    ...overrides,
  };
}

function makeState(overrides: Partial<StateFile> = {}): StateFile {
  return {
    version: 1,
    environments: [
      makeEnvironment(),
      makeEnvironment({
        name: "dev-vm",
        environmentId: "env-dev",
        label: "Dev VM",
        httpBaseUrl: "http://dev-vm:3773",
        wsBaseUrl: "ws://dev-vm:3773",
      }),
    ],
    agents: [makeAgent()],
    subscriptions: [],
    notifications: [],
    ...overrides,
  };
}

describe("agent target resolution", () => {
  it("recognizes raw T3 thread UUIDs", () => {
    expect(isRawThreadUuid("22222222-2222-4222-8222-222222222222")).toBe(true);
    expect(isRawThreadUuid("worker-a")).toBe(false);
  });

  it("resolves saved names without remote scanning", async () => {
    const clientFactory = vi.fn(() => ({
      listThreads: vi.fn(async () => []),
    }));

    const resolved = await resolveAgentTarget(makeState(), "worker-a", { clientFactory });

    expect(resolved.savedAgent?.name).toBe("worker-a");
    expect(resolved.threadId).toBe("11111111-1111-4111-8111-111111111111");
    expect(clientFactory).not.toHaveBeenCalled();
  });

  it("prefers an existing saved mapping when the input is a raw thread UUID", async () => {
    const clientFactory = vi.fn(() => ({
      listThreads: vi.fn(async () => []),
    }));

    const resolved = await resolveAgentTarget(makeState(), "11111111-1111-4111-8111-111111111111", {
      clientFactory,
    });

    expect(resolved.savedAgent?.name).toBe("worker-a");
    expect(resolved.environment).toBe("local-mbp");
    expect(clientFactory).not.toHaveBeenCalled();
  });

  it("resolves an unsaved raw UUID by scanning paired environments", async () => {
    const threadsByEnvironment = new Map<string, OrchestrationThreadShell[]>([
      ["local-mbp", []],
      ["dev-vm", [makeThread()]],
    ]);
    const clientFactory = vi.fn((environmentName: string) => ({
      listThreads: vi.fn(async () => threadsByEnvironment.get(environmentName) ?? []),
    }));

    const resolved = await resolveAgentTarget(makeState(), "22222222-2222-4222-8222-222222222222", {
      clientFactory,
    });

    expect(resolved.savedAgent).toBeNull();
    expect(resolved.environment).toBe("dev-vm");
    expect(resolved.projectId).toBe("project-2");
    expect(resolved.title).toBe("Unsaved Worker");
    expect(resolved.checkedEnvironments).toEqual(["local-mbp", "dev-vm"]);
  });

  it("checks the preferred environment first when scanning a raw UUID", async () => {
    const clientFactory = vi.fn((environmentName: string) => ({
      listThreads: vi.fn(async () => (environmentName === "dev-vm" ? [makeThread()] : [])),
    }));

    const resolved = await resolveAgentTarget(makeState(), "22222222-2222-4222-8222-222222222222", {
      preferredEnvironment: "dev-vm",
      clientFactory,
    });

    expect(resolved.checkedEnvironments[0]).toBe("dev-vm");
    expect(clientFactory.mock.calls[0]?.[0]).toBe("dev-vm");
  });

  it("reports paired environments checked when a raw UUID is not found", async () => {
    const clientFactory = vi.fn(() => ({
      listThreads: vi.fn(async () => []),
    }));

    await expect(
      resolveAgentTarget(makeState(), "33333333-3333-4333-8333-333333333333", { clientFactory }),
    ).rejects.toThrow(
      "Unknown thread '33333333-3333-4333-8333-333333333333'. Checked paired environments: local-mbp, dev-vm.",
    );
  });

  it("keeps non-UUID unknown inputs on the saved-agent path", async () => {
    const clientFactory = vi.fn(() => ({
      listThreads: vi.fn(async () => []),
    }));

    await expect(
      resolveAgentTarget(makeState(), "missing-worker", { clientFactory }),
    ).rejects.toThrow("Unknown agent 'missing-worker'.");
    expect(clientFactory).not.toHaveBeenCalled();
  });

  it("reports unsupported local-state features for unsaved raw UUID targets", async () => {
    const target = await resolveAgentTarget(makeState(), "22222222-2222-4222-8222-222222222222", {
      clientFactory: (environmentName) => ({
        listThreads: async () => (environmentName === "dev-vm" ? [makeThread()] : []),
      }),
    });

    expect(() => assertSavedAgentCapability(target, "`result --mark-seen`")).toThrow(
      "`result --mark-seen` requires a saved agent name. Raw thread UUIDs do not persist local state.",
    );
  });

  it("exposes the saved-agent-only helper for direct local matches", () => {
    const resolved = resolveSavedAgentTarget(makeState(), "worker-a");
    expect(resolved?.savedAgent?.name).toBe("worker-a");
    expect(resolveSavedAgentTarget(makeState(), "missing-worker")).toBeNull();
  });
});

describe("thread UUID search", () => {
  it("returns the saved mapping without remote scanning", async () => {
    const clientFactory = vi.fn(() => ({
      listThreads: vi.fn(async () => []),
    }));

    const target = await resolveAgentTarget(makeState(), "11111111-1111-4111-8111-111111111111", {
      clientFactory,
      requireUniqueRemoteMatch: true,
    });

    expect(toThreadSearchResult(target)).toEqual({
      threadId: "11111111-1111-4111-8111-111111111111",
      environment: "local-mbp",
      projectId: "project-1",
      saved: true,
      savedName: "worker-a",
      title: "Worker A",
    });
    expect(clientFactory).not.toHaveBeenCalled();
  });

  it("returns an unsaved exact remote UUID match", async () => {
    const target = await resolveAgentTarget(makeState(), "22222222-2222-4222-8222-222222222222", {
      clientFactory: (environmentName) => ({
        listThreads: async () => (environmentName === "dev-vm" ? [makeThread()] : []),
      }),
      requireUniqueRemoteMatch: true,
    });

    expect(toThreadSearchResult(target)).toEqual({
      threadId: "22222222-2222-4222-8222-222222222222",
      environment: "dev-vm",
      projectId: "project-2",
      saved: false,
      savedName: null,
      title: "Unsaved Worker",
    });
  });

  it("rejects malformed search input before lookup", () => {
    expect(() => assertThreadSearchUuid("worker-a")).toThrow(
      "Expected a full T3 thread UUID, received 'worker-a'.",
    );
  });

  it("reports every paired environment after an exact UUID search misses", async () => {
    await expect(
      resolveAgentTarget(makeState(), "33333333-3333-4333-8333-333333333333", {
        clientFactory: () => ({ listThreads: async () => [] }),
        requireUniqueRemoteMatch: true,
      }),
    ).rejects.toThrow(
      "Unknown thread '33333333-3333-4333-8333-333333333333'. Checked paired environments: local-mbp, dev-vm.",
    );
  });

  it("restricts remote search to --env and rejects a conflicting saved mapping", async () => {
    await expect(
      resolveAgentTarget(makeState(), "11111111-1111-4111-8111-111111111111", {
        environmentFilter: "dev-vm",
        clientFactory: () => ({ listThreads: async () => [] }),
        requireUniqueRemoteMatch: true,
      }),
    ).rejects.toThrow(
      "Thread '11111111-1111-4111-8111-111111111111' is saved as 'worker-a' in environment 'local-mbp', which does not match --env 'dev-vm'. Omit --env to use the saved mapping.",
    );

    await expect(
      resolveAgentTarget(makeState(), "33333333-3333-4333-8333-333333333333", {
        environmentFilter: "dev-vm",
        clientFactory: () => ({ listThreads: async () => [] }),
        requireUniqueRemoteMatch: true,
      }),
    ).rejects.toThrow(
      "Unknown thread '33333333-3333-4333-8333-333333333333'. Checked paired environments: dev-vm.",
    );
  });

  it("rejects duplicate remote UUID matches until --env selects one", async () => {
    await expect(
      resolveAgentTarget(makeState(), "22222222-2222-4222-8222-222222222222", {
        clientFactory: () => ({ listThreads: async () => [makeThread()] }),
        requireUniqueRemoteMatch: true,
      }),
    ).rejects.toThrow(
      "Thread '22222222-2222-4222-8222-222222222222' was found in multiple paired environments: local-mbp, dev-vm. Use --env <name> to select one.",
    );

    const scoped = await resolveAgentTarget(makeState(), "22222222-2222-4222-8222-222222222222", {
      environmentFilter: "dev-vm",
      clientFactory: () => ({ listThreads: async () => [makeThread()] }),
      requireUniqueRemoteMatch: true,
    });

    expect(scoped.environment).toBe("dev-vm");
    expect(scoped.checkedEnvironments).toEqual(["dev-vm"]);
  });
});
