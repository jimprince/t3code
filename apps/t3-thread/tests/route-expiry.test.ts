import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";
import * as NodeUtil from "node:util";
import * as NodeURL from "node:url";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { NodeId, RuntimeRequestId } from "@t3tools/contracts";
import { DateTime } from "effect";
import { buildSubscriptionRecord, loadState, saveState } from "../src/state.js";
import {
  detectAttentionEvents,
  deliverPendingNotifications,
  type WatchClientFactory,
  createWatchPoller,
} from "../src/watch.js";
import type {
  OrchestrationThread,
  OrchestrationThreadShell,
  SavedSubscription,
} from "../src/types.js";

const date = "2026-10-13T00:00:00.000Z";
const execFile = NodeUtil.promisify(NodeChildProcess.execFile);
const workspace = NodeURL.fileURLToPath(new URL("..", import.meta.url));
let directory: string;
let child: OrchestrationThread;
let listed = true;
const sent = vi.fn();
const now = () => date;
const thread = (id: string): OrchestrationThread => ({
  id,
  projectId: "project",
  title: id,
  modelSelection: { provider: "codex", model: "gpt-6.1-sol" },
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
const route = (derived = true): SavedSubscription => ({
  nestingDerived: derived,
  sourceThreadId: "child",
  sourceAgentName: null,
  sourceEnvironment: "test",
  subscriberThreadId: derived ? "parent" : "explicit",
  subscriberAgentName: null,
  subscriberEnvironment: "test",
  createdAt: date,
  updatedAt: date,
  events: "attention",
});
const factory: WatchClientFactory = () => ({
  listThreads: async () =>
    listed
      ? [
          {
            ...child,
            latestUserMessageAt: null,
            hasPendingApprovals: false,
            hasPendingUserInput: Boolean(child.runtimeRequests?.length),
            hasActionableProposedPlan: false,
          } as OrchestrationThreadShell,
        ]
      : [],
  findThread: async (id) => (id === "child" ? child : thread(id)),
  sendMessage: sent,
});
const active = (routes: SavedSubscription[]) => routes.filter((r) => !r.expiryReason);
const reason = (r?: SavedSubscription) => r?.expiryReason;
async function pass() {
  await detectAttentionEvents({ clientFactory: factory, now });
  return loadState();
}
beforeEach(async () => {
  directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-route-expiry-"));
  vi.stubEnv("T3_AGENT_STATE_FILE", NodePath.join(directory, "state.json"));
  child = { ...thread("child"), parentThreadId: "parent" };
  listed = true;
  sent.mockReset();
  await saveState({
    version: 1,
    environments: [
      {
        name: "test",
        environmentId: "test",
        label: "test",
        httpBaseUrl: "http://example.test",
        wsBaseUrl: "ws://example.test",
        bearerToken: "fixture",
        expiresAt: "2099-01-01T00:00:00Z",
        pairedAt: date,
        serverVersion: "test",
      },
    ],
    agents: [],
    subscriptions: [route(), route(false)],
    notifications: [],
    queuedSends: [],
  });
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await NodeFSP.rm(directory, { recursive: true, force: true });
});
it("expires a seeded derived route on settle and reduces active count from 2 to 1", async () => {
  expect(active((await loadState()).subscriptions)).toHaveLength(2);
  child.settledOverride = "settled";
  const state = await pass();
  expect(active(state.subscriptions)).toHaveLength(1);
  expect(reason(state.subscriptions.find((r) => r.nestingDerived))).toBe("settled");
  expect(active((await pass()).subscriptions)).toHaveLength(1);
});
it("expires on archive even when the source disappears from the active shell list", async () => {
  child.archivedAt = date;
  listed = false;
  const state = await pass();
  expect(active(state.subscriptions)).toHaveLength(1);
  expect(reason(state.subscriptions.find((r) => r.nestingDerived))).toBe("archived");
});
it("re-derives on unsettle without duplicating routes", async () => {
  child.settledOverride = "settled";
  expect(active((await pass()).subscriptions)).toHaveLength(1);
  child.settledOverride = "active";
  expect(active((await pass()).subscriptions)).toHaveLength(2);
  expect(active((await pass()).subscriptions)).toHaveLength(2);
});
it("keeps a derived unsubscribe inactive beyond five minutes and across unsettle", async () => {
  const env = {
    ...process.env,
    T3_THREAD_ID: "parent",
    T3_ENVIRONMENT_ID: "test",
    T3_ENVIRONMENT_NAME: "test",
  };
  await execFile(
    NodePath.join(workspace, "node_modules/.bin/tsx"),
    ["src/cli.ts", "unsubscribe", "--subscriber", "parent", "--watch", "child"],
    { cwd: workspace, env },
  );
  await detectAttentionEvents({ clientFactory: factory, now: () => "2026-10-13T00:06:00.000Z" });
  expect(reason((await loadState()).subscriptions.find((r) => r.nestingDerived))).toBe(
    "unsubscribed",
  );
  child.settledOverride = "settled";
  await pass();
  child.settledOverride = "active";
  expect(active((await pass()).subscriptions)).toHaveLength(1);
  child.parentThreadId = null;
  await pass();
  child.parentThreadId = "parent";
  expect(active((await pass()).subscriptions)).toHaveLength(1);
  const current = await loadState();
  const existing = current.subscriptions.find((r) => r.nestingDerived)!;
  const explicit = buildSubscriptionRecord(
    { threadId: "parent", name: null, environment: "test" },
    { threadId: "child", name: null, environment: "test" },
    date,
    existing,
  );
  await saveState({
    ...current,
    subscriptions: current.subscriptions.map((r) => (r === existing ? explicit : r)),
  });
  expect(active((await pass()).subscriptions)).toHaveLength(2);
}, 15_000);
it("reports active route counts and expiry reasons through the existing CLI inspection", async () => {
  child.settledOverride = "settled";
  await pass();
  const env = { ...process.env };
  const cli = async (...args: string[]) =>
    JSON.parse(
      (
        await execFile(
          NodePath.join(workspace, "node_modules/.bin/tsx"),
          ["src/cli.ts", "subscriptions", ...args],
          { cwd: workspace, env },
        )
      ).stdout,
    );
  expect(await cli()).toHaveLength(1);
  expect(await cli("--subscriber", "parent", "--summary", "--include-expired")).toMatchObject({
    activeCount: 0,
    expiredCount: 1,
    routes: [{ expiryReason: "settled" }],
  });
}, 15_000);
it("restores an archived source after reopening and retains expiry during failed reads", async () => {
  child.archivedAt = date;
  listed = false;
  expect(reason((await pass()).subscriptions.find((r) => r.nestingDerived))).toBe("archived");
  const offline: WatchClientFactory = () => ({
    listThreads: async () => {
      throw new Error("offline");
    },
    findThread: async () => {
      throw new Error("offline");
    },
    sendMessage: sent,
  });
  await detectAttentionEvents({ clientFactory: offline, now });
  expect(reason((await loadState()).subscriptions.find((r) => r.nestingDerived))).toBe("archived");
  child.archivedAt = null;
  listed = true;
  expect(active((await pass()).subscriptions)).toHaveLength(2);
});
it("refreshes parked archive reads when the source reappears in the watcher shell list", async () => {
  let clock = Date.parse(date);
  const poller = createWatchPoller(factory, () => clock);
  const env = (await loadState()).environments[0]!;
  child.archivedAt = date;
  await poller.clientFactory(env).findThread("child");
  expect(poller.skippedMappings()).toContainEqual({ mapping: "test:child", reason: "archived" });
  child = { ...child, archivedAt: null, settledOverride: "active" };
  clock += 60_000;
  poller.beginPoll();
  await poller.clientFactory(env).listThreads!();
  expect((await poller.clientFactory(env).findThread("child")).archivedAt).toBeNull();
  expect(poller.skippedMappings()).toEqual([]);
});
it("preserves explicit routes byte for byte while expiring derived routes", async () => {
  const original = (await loadState()).subscriptions.find((r) => !r.nestingDerived);
  child.settledOverride = "settled";
  const state = await pass();
  expect(state.subscriptions.find((r) => !r.nestingDerived)).toEqual(original);
  expect(active(state.subscriptions).map((r) => r.subscriberThreadId)).toEqual(["explicit"]);
});
it("does not deliver pending child attention through an expired route", async () => {
  child.runtimeRequests = [
    {
      id: RuntimeRequestId.make("question"),
      nodeId: NodeId.make("node"),
      providerTurnId: null,
      nativeRequestRef: null,
      kind: "user_input",
      status: "pending",
      responseCapability: { type: "message" },
      createdAt: DateTime.makeUnsafe(date),
      resolvedAt: null,
    },
  ];
  await pass();
  // Keep only derived routing here so explicit delivery remains independently valid.
  const state = await loadState();
  expect(state.notifications.filter((n) => n.subscriberThreadId === "parent")).toHaveLength(1);
  await saveState({
    ...state,
    subscriptions: state.subscriptions.filter((r) => r.nestingDerived),
    notifications: state.notifications.filter((n) => n.subscriberThreadId === "parent"),
  });
  child.settledOverride = "settled";
  await pass();
  // Reopening before delivery must not resurrect the expired request's notice.
  child.settledOverride = "active";
  await deliverPendingNotifications({ clientFactory: factory, now });
  expect(sent).not.toHaveBeenCalled();
  expect((await loadState()).notifications.every((n) => n.status === "superseded")).toBe(true);
  child.runtimeRequests[0]!.id = RuntimeRequestId.make("new-question");
  await pass();
  await deliverPendingNotifications({ clientFactory: factory, now });
  expect(sent).toHaveBeenCalledOnce();
});
it("expires on completion and restores on reopening the source", async () => {
  child.latestTurn = {
    turnId: "run",
    state: "completed",
    requestedAt: date,
    startedAt: date,
    completedAt: date,
    assistantMessageId: null,
  };
  expect(reason((await pass()).subscriptions.find((r) => r.nestingDerived))).toBe("completed");
  child.settledOverride = "active";
  child.unsettledAt = "2026-10-13T00:01:00.000Z";
  expect(active((await pass()).subscriptions)).toHaveLength(2);
  child.latestTurn.completedAt = "2026-10-13T00:02:00.000Z";
  expect(reason((await pass()).subscriptions.find((r) => r.nestingDerived))).toBe("completed");
});
