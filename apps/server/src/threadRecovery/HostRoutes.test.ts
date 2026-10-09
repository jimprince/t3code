import { test, expect } from "vite-plus/test";
import { ThreadId, type HandoverRoutesInput } from "@t3tools/contracts";
import { transferHostRoutes } from "./HostRoutes.ts";
const old = ThreadId.make("old"),
  successor = ThreadId.make("new");
const input: HandoverRoutesInput = {
  transferId: "handover",
  oldThreadId: old,
  successorThreadId: successor,
  targetEnvironment: "dev-vm",
  expectedGeneration: 0,
  requestId: "host-1",
  reason: "watchdog",
};
const route = {
  subscriberThreadId: old,
  subscriberEnvironment: "dev-vm",
  sourceThreadId: "child",
  sourceEnvironment: "mac",
  level: "attention",
  inputReminderMinutes: 23,
  inactivityMinutes: 9,
  baselineTurnId: "run-7",
  inactivityObservation: { since: "yesterday" },
  nestingDerived: true,
  createdAt: "before",
  updatedAt: "before",
};
test("host transfer preserves every watcher setting, pending recipient, held send key and saved alias under one mutation", () => {
  const state = {
    subscriptions: [route],
    notifications: [
      {
        subscriberThreadId: old,
        subscriberEnvironment: "dev-vm",
        status: "held",
        eventKey: "unchanged-event-key",
        deliveryClaimId: null,
      },
    ],
    queuedSends: [
      {
        id: "send",
        threadId: old,
        environment: "dev-vm",
        status: "waiting",
        dispatchClaimId: null,
        sendId: "stable-send",
        sequence: 7,
      },
    ],
    agents: [{ name: "chief", threadId: old, environment: "dev-vm" }],
    environments: [{ name: "dev-vm", bearerToken: "never-in-receipt" }],
    opaque: { keep: true },
  };
  const moved = transferHostRoutes(state, input, "admin", "host-uuid", "now");
  expect(moved.state).toMatchObject({
    subscriptions: [{ ...route, subscriberThreadId: successor, updatedAt: "now" }],
    notifications: [{ eventKey: "unchanged-event-key", subscriberThreadId: successor }],
    queuedSends: [{ sendId: "stable-send", threadId: successor, sequence: 7 }],
    agents: [{ name: "chief", threadId: successor }],
    opaque: { keep: true },
  });
  expect(JSON.stringify(moved.receipt)).not.toContain("never-in-receipt");
  expect(state.subscriptions[0]?.subscriberThreadId).toBe(old);
  const persisted = {
    ...moved.state,
    handoverReceipts: [
      {
        key: moved.key,
        fingerprint: moved.fingerprint,
        receipt: { ...moved.receipt, digest: "digest" },
      },
    ],
  };
  expect(transferHostRoutes(persisted, input, "admin", "host-uuid", "later").receipt.digest).toBe(
    "digest",
  );
  expect(() =>
    transferHostRoutes(
      persisted,
      { ...input, requestId: "new-key" },
      "admin",
      "host-uuid",
      "later",
    ),
  ).toThrow("generation changed");
  expect(() =>
    transferHostRoutes(persisted, { ...input, reason: "different" }, "admin", "host-uuid", "later"),
  ).toThrow("different transfer");
});
test("conflicting successor route, in-flight notification/send and self-route are refused without mutating the source", () => {
  const target = { ...route, subscriberThreadId: successor };
  const state = { subscriptions: [route, target] };
  expect(() => transferHostRoutes(state, input, "admin", "host", "now")).toThrow(
    "already has a subscription",
  );
  expect(state.subscriptions).toEqual([route, target]);
  expect(() =>
    transferHostRoutes(
      { subscriptions: [{ ...route, sourceThreadId: successor, sourceEnvironment: "dev-vm" }] },
      input,
      "admin",
      "host",
      "now",
    ),
  ).toThrow("self subscription");
  expect(() =>
    transferHostRoutes(
      {
        subscriptions: [route],
        notifications: [
          {
            subscriberThreadId: old,
            subscriberEnvironment: "dev-vm",
            status: "pending",
            deliveryClaimId: "live-claim",
          },
        ],
      },
      input,
      "admin",
      "host",
      "now",
    ),
  ).toThrow("claimed");
  expect(() =>
    transferHostRoutes(
      { queuedSends: [{ threadId: old, environment: "dev-vm", status: "uncertain" }] },
      input,
      "admin",
      "host",
      "now",
    ),
  ).toThrow("uncertain");
});
