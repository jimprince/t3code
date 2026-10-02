// @effect-diagnostics nodeBuiltinImport:off - exercises the real CLI JSON file and lock from Promise-based storage calls.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { ThreadId } from "@t3tools/contracts";
import { loadState, saveState, updateState } from "@t3tools/shared/threadRoutingState";
import { listThreadSubscriptions, updateThreadSubscriptions } from "./threadSubscriptions.ts";

const route = (subscriberThreadId: string, sourceThreadId: string) => ({
  subscriberThreadId,
  subscriberAgentName: "supervisor",
  subscriberEnvironment: "local",
  sourceThreadId,
  sourceAgentName: sourceThreadId,
  sourceEnvironment: "remote",
  createdAt: "2026-09-30T00:00:00.000Z",
  updatedAt: "2026-09-30T00:00:00.000Z",
});

async function fixture(test: () => Promise<void>) {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-route-store-"));
  const previous = process.env.T3_AGENT_STATE_FILE;
  process.env.T3_AGENT_STATE_FILE = NodePath.join(directory, "state.json");
  try {
    await test();
  } finally {
    if (previous === undefined) delete process.env.T3_AGENT_STATE_FILE;
    else process.env.T3_AGENT_STATE_FILE = previous;
    await NodeFSP.rm(directory, { recursive: true, force: true });
  }
}

describe("thread subscription storage", () => {
  it("lists, removes, restores, and preserves other supervisors, credentials, queue and audit", async () =>
    fixture(async () => {
      const selected = {
        ...route("chosen", "worker"),
        level: "none" as const,
        inputReminderMinutes: 10,
        lastDirectMessageTurnId: "turn-direct",
        errorEventKey: "failure",
        observedState: "error",
        observedReason: "quota",
      };
      const other = { ...route("other", "worker"), futureRouteField: "retained" };
      const state = {
        version: 1,
        subscriptions: [selected, other],
        environments: [{ bearerToken: "private-token" }],
        agents: [],
        queuedSends: [{ text: "retain" }],
        futureField: "retain",
        notifications: [
          { ...selected, status: "held" },
          { ...other, status: "pending" },
          { ...selected, status: "delivered" },
        ],
      };
      await saveState(state);
      const listed = await listThreadSubscriptions("chosen");
      expect(listed.routes).toEqual([selected]);
      expect(JSON.stringify(listed)).not.toContain("private-token");
      const removed = await updateThreadSubscriptions({
        threadId: ThreadId.make("chosen"),
        action: "remove",
        routes: listed.routes,
      });
      expect((await listThreadSubscriptions("chosen")).routes).toEqual([]);
      const persisted = await loadState(state);
      expect(persisted).toMatchObject({
        environments: state.environments,
        queuedSends: state.queuedSends,
        futureField: "retain",
        subscriptions: [other],
      });
      expect(persisted.notifications.map((event) => event.status)).toEqual([
        "superseded",
        "pending",
        "delivered",
      ]);
      await updateThreadSubscriptions({
        threadId: ThreadId.make("chosen"),
        action: "restore",
        routes: removed.routes,
      });
      await updateThreadSubscriptions({
        threadId: ThreadId.make("chosen"),
        action: "restore",
        routes: removed.routes,
      });
      expect((await listThreadSubscriptions("chosen")).routes).toEqual([selected]);
      expect((await loadState(state)).subscriptions).toContainEqual(other);
    }));

  it("serializes removal with concurrent CLI writes and rejects routes for another subscriber", async () =>
    fixture(async () => {
      const selected = route("chosen", "worker");
      await saveState({ subscriptions: [selected] });
      await Promise.all([
        updateThreadSubscriptions({
          threadId: ThreadId.make("chosen"),
          action: "remove",
          routes: [selected],
        }),
        updateState({}, (state) => ({ state: { ...state, cliWrite: "retained" }, result: null })),
      ]);
      expect(await loadState({})).toEqual({ subscriptions: [], cliWrite: "retained" });
      await expect(
        updateThreadSubscriptions({
          threadId: ThreadId.make("wrong"),
          action: "restore",
          routes: [selected],
        }),
      ).rejects.toThrow("selected subscriber");
      expect((await listThreadSubscriptions("chosen")).routes).toEqual([]);
    }));
});
