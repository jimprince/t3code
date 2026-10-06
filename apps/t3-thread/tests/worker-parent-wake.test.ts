import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { RuntimeRequestId, NodeId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import {
  detectAttentionEvents,
  deliverPendingNotifications,
  type WatchClientFactory,
} from "../src/watch.js";
import { saveState, loadState } from "../src/state.js";
import type { OrchestrationThread, SavedEnvironment } from "../src/types.js";
const date = "2026-10-05T00:00:00Z";
const env = (name: string, id: string): SavedEnvironment => ({
  name,
  environmentId: id,
  label: name,
  httpBaseUrl: "http://example.test",
  wsBaseUrl: "ws://example.test",
  serverVersion: "v2",
  bearerToken: "test",
  expiresAt: "2099-01-01T00:00:00Z",
  pairedAt: date,
});
const thread = (id: string): OrchestrationThread => ({
  id,
  projectId: "project",
  title: id,
  modelSelection: { provider: "codex", model: "gpt-5.4" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  latestTurn: null,
  createdAt: date,
  updatedAt: date,
  archivedAt: null,
  messages: [],
  proposedPlans: [],
  activities: [],
  checkpoints: [],
  session: null,
});
afterEach(() => vi.unstubAllEnvs());
it.each([false, true])(
  "wakes the current parent (remote=%s) despite a saved same-UUID parent on another host",
  async (remote) => {
    const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-focus-v2-"));
    try {
      vi.stubEnv("T3_AGENT_STATE_FILE", NodePath.join(directory, "state.json"));
      const child: OrchestrationThread = {
        ...thread("child"),
        ...(remote
          ? { remoteParent: { environmentId: "descriptor", threadId: "parent" } }
          : { parentThreadId: "parent" }),
        runtimeRequests: [
          {
            id: RuntimeRequestId.make("question"),
            nodeId: NodeId.make("node"),
            providerTurnId: null,
            nativeRequestRef: null,
            kind: "user_input" as const,
            status: "pending" as const,
            responseCapability: { type: "message" as const },
            createdAt: DateTime.makeUnsafe(date),
            resolvedAt: null,
          },
        ],
      };
      const parent = { ...thread("parent"), settledOverride: "settled" as const };
      await saveState({
        version: 1,
        environments: [env("local", "local-id"), env("renamed", "descriptor")],
        agents: [
          {
            name: "wrong-host-parent",
            threadId: "parent",
            environment: "renamed",
            projectId: "project",
            title: "parent",
            createdAt: date,
            lastSeenAssistantMessageId: null,
          },
        ],
        subscriptions: [],
        notifications: [],
        queuedSends: [],
      });
      const sent: string[] = [];
      const factory: WatchClientFactory = (environment) => ({
        listThreads: async () =>
          environment.name === "local"
            ? [
                {
                  ...child,
                  latestUserMessageAt: null,
                  hasPendingApprovals: false,
                  hasPendingUserInput: true,
                  hasActionableProposedPlan: false,
                },
              ]
            : [],
        findThread: async (id) => (id === "child" ? child : parent),
        sendMessage: async (input) => {
          sent.push(environment.name + ":" + input.threadId);
        },
      });
      const clock = Date.parse(date);
      const now = () => new Date(clock).toISOString();
      await detectAttentionEvents({ clientFactory: factory, now });
      expect((await deliverPendingNotifications({ clientFactory: factory, now }))[0]?.status).toBe(
        "delivered",
      );
      expect(sent).toEqual([`${remote ? "renamed" : "local"}:parent`]);
      const state = await loadState();
      expect(state.subscriptions[0]?.sourceEnvironment).toBe("local");
      expect(state.subscriptions[0]?.subscriberEnvironment).toBe(remote ? "renamed" : "local");
      // A newly pending request aimed at a previous parent must not wake it after unnesting.
      child.runtimeRequests[0]!.id = RuntimeRequestId.make("replacement-question");
      await detectAttentionEvents({ clientFactory: factory, now });
      child.parentThreadId = null;
      if ("remoteParent" in child) child.remoteParent = null;
      const obsolete = await deliverPendingNotifications({ clientFactory: factory, now });
      expect(obsolete.some((notification) => notification.status === "superseded")).toBe(true);
      expect(sent).toHaveLength(1);
    } finally {
      await NodeFSP.rm(directory, { recursive: true, force: true });
    }
  },
);
