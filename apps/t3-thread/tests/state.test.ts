import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  assertNotSelfSubscription,
  buildSubscriptionRecord,
  findAgentByThreadId,
  removeAgent,
  removeSubscription,
  resolveCallerThreadId,
  resolveNotifyPreference,
  updateState,
  upsertSubscription,
} from "../src/state.js";
import type { SavedAgent, SavedSubscription, StateFile } from "../src/types.js";

function makeAgent(overrides: Partial<SavedAgent> = {}): SavedAgent {
  return {
    name: "worker-a",
    environment: "local-mbp",
    threadId: "thread-worker-a",
    projectId: "project-1",
    title: "Worker A",
    createdAt: "2026-04-17T00:00:00.000Z",
    lastSeenAssistantMessageId: null,
    ...overrides,
  };
}

function makeSubscription(overrides: Partial<SavedSubscription> = {}): SavedSubscription {
  return {
    subscriberThreadId: "thread-coordinator-a",
    subscriberAgentName: "coordinator-a",
    subscriberEnvironment: "local-mbp",
    sourceThreadId: "thread-worker-a",
    sourceAgentName: "worker-a",
    sourceEnvironment: "local-mbp",
    createdAt: "2026-04-17T00:00:00.000Z",
    updatedAt: "2026-04-17T00:00:00.000Z",
    ...overrides,
  };
}

function makeState(overrides: Partial<StateFile> = {}): StateFile {
  return {
    version: 1,
    environments: [],
    agents: [makeAgent(), makeAgent({ name: "coordinator-a", threadId: "thread-coordinator-a" })],
    subscriptions: [],
    notifications: [],
    ...overrides,
  };
}

describe("state helpers", () => {
  it("resolves caller thread id from T3_THREAD_ID", () => {
    expect(resolveCallerThreadId({ T3_THREAD_ID: " thread-123 " } as NodeJS.ProcessEnv)).toBe(
      "thread-123",
    );
  });

  it("returns null when T3_THREAD_ID is missing", () => {
    expect(resolveCallerThreadId({} as NodeJS.ProcessEnv)).toBeNull();
  });

  it("defaults notify preference to caller when T3_THREAD_ID is present", () => {
    expect(
      resolveNotifyPreference(undefined, { T3_THREAD_ID: "thread-123" } as NodeJS.ProcessEnv),
    ).toEqual({
      kind: "caller",
    });
  });

  it("defaults notify preference to none when no caller thread exists", () => {
    expect(resolveNotifyPreference(undefined, {} as NodeJS.ProcessEnv)).toEqual({
      kind: "none",
    });
  });

  it("supports explicit notify opt-out", () => {
    expect(
      resolveNotifyPreference(false, { T3_THREAD_ID: "thread-123" } as NodeJS.ProcessEnv),
    ).toEqual({
      kind: "none",
    });
  });

  it("supports explicit notify subscriber overrides", () => {
    expect(resolveNotifyPreference(" current-orchestrator ")).toEqual({
      kind: "explicit",
      subscriber: "current-orchestrator",
    });
  });

  it("rejects explicit bare notify when there is no caller thread", () => {
    expect(() => resolveNotifyPreference(true, {} as NodeJS.ProcessEnv)).toThrow(
      "T3_THREAD_ID is not set. Bare `agent create --notify` must run inside a T3 thread or specify `--notify <subscriber>`.",
    );
  });

  it("finds a saved agent by thread id", () => {
    const state = makeState();
    expect(findAgentByThreadId(state, "thread-worker-a")?.name).toBe("worker-a");
    expect(findAgentByThreadId(state, "missing-thread")).toBeNull();
  });

  it("removes a saved agent by name", () => {
    const remaining = removeAgent(makeState().agents, "worker-a");
    expect(remaining.map((agent) => agent.name)).toEqual(["coordinator-a"]);
  });

  it("upserts subscriptions by subscriber/source thread pair", () => {
    const initial = [makeSubscription()];
    const updated = upsertSubscription(
      initial,
      makeSubscription({
        updatedAt: "2026-04-17T01:00:00.000Z",
      }),
    );

    expect(updated).toHaveLength(1);
    expect(updated[0]?.updatedAt).toBe("2026-04-17T01:00:00.000Z");
  });

  it("removes subscriptions by subscriber/source thread pair", () => {
    const remaining = removeSubscription(
      [
        makeSubscription(),
        makeSubscription({
          sourceThreadId: "thread-worker-b",
          sourceAgentName: "worker-b",
        }),
      ],
      {
        subscriberThreadId: "thread-coordinator-a",
        sourceThreadId: "thread-worker-a",
      },
    );

    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.sourceAgentName).toBe("worker-b");
  });

  it("builds a subscription record from caller and source agents", () => {
    const caller = {
      threadId: "thread-coordinator-a",
      name: "coordinator-a",
      environment: "local-mbp",
    };
    const source = {
      threadId: "thread-worker-b",
      name: "worker-b",
      environment: "dev-vm",
    };

    expect(
      buildSubscriptionRecord(caller, source, "2026-04-18T19:00:00.000Z"),
    ).toEqual({
      subscriberThreadId: "thread-coordinator-a",
      subscriberAgentName: "coordinator-a",
      subscriberEnvironment: "local-mbp",
      sourceThreadId: "thread-worker-b",
      sourceAgentName: "worker-b",
      sourceEnvironment: "dev-vm",
      createdAt: "2026-04-18T19:00:00.000Z",
      updatedAt: "2026-04-18T19:00:00.000Z",
    });
  });

  it("supports subscription records for raw subscriber threads with no saved agent name", () => {
    const caller = {
      threadId: "thread-unsaved-caller",
      name: null,
      environment: "local-mbp",
    };
    const source = {
      threadId: "thread-worker-b",
      name: "worker-b",
      environment: "dev-vm",
    };

    expect(
      buildSubscriptionRecord(caller, source, "2026-04-18T19:00:00.000Z"),
    ).toEqual({
      subscriberThreadId: "thread-unsaved-caller",
      subscriberAgentName: null,
      subscriberEnvironment: "local-mbp",
      sourceThreadId: "thread-worker-b",
      sourceAgentName: "worker-b",
      sourceEnvironment: "dev-vm",
      createdAt: "2026-04-18T19:00:00.000Z",
      updatedAt: "2026-04-18T19:00:00.000Z",
    });
  });

  it("rejects self-subscriptions", () => {
    const caller = makeAgent({ name: "coordinator-a", threadId: "thread-coordinator-a" });
    const source = makeAgent({ name: "coordinator-a", threadId: "thread-coordinator-a" });

    expect(() => assertNotSelfSubscription(caller, source)).toThrow(
      "Subscriber 'coordinator-a' cannot subscribe to itself.",
    );
  });

  it("serializes concurrent state updates so both writes are preserved", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "t3-agent-state-test-"));
    const stateFile = path.join(tempDir, "state.json");
    const previousStateFile = process.env.T3_AGENT_STATE_FILE;
    process.env.T3_AGENT_STATE_FILE = stateFile;

    try {
      await writeFile(
        stateFile,
        `${JSON.stringify(makeState({ agents: [], subscriptions: [], notifications: [] }), null, 2)}\n`,
        "utf8",
      );

      await Promise.all([
        updateState(async (state) => {
          await new Promise((resolve) => setTimeout(resolve, 100));
          return {
            state: {
              ...state,
              agents: [...state.agents, makeAgent({ name: "worker-a", threadId: "thread-worker-a" })],
            },
            result: null,
          };
        }),
        updateState(async (state) => ({
          state: {
            ...state,
            agents: [...state.agents, makeAgent({ name: "worker-b", threadId: "thread-worker-b" })],
          },
          result: null,
        })),
      ]);

      const finalState = JSON.parse(await readFile(stateFile, "utf8")) as {
        agents: Array<{ name: string }>;
      };
      expect(finalState.agents.map((agent) => agent.name).sort()).toEqual(["worker-a", "worker-b"]);
    } finally {
      if (previousStateFile === undefined) {
        delete process.env.T3_AGENT_STATE_FILE;
      } else {
        process.env.T3_AGENT_STATE_FILE = previousStateFile;
      }
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
