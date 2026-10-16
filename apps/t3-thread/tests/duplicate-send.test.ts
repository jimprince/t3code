import { describe, expect, it } from "vite-plus/test";
import { HandoffReceipt, ThreadId, RunId } from "@t3tools/contracts";
import {
  duplicateSendCandidate,
  duplicateSendHash,
  duplicateSendState,
} from "../src/duplicateSend.js";

const metadata = {
  hash: duplicateSendHash("target", "continue the follow-up"),
  senderThreadId: "sender",
};
const receipt: HandoffReceipt = {
  sendId: "original",
  recipientThreadId: ThreadId.make("target"),
  acceptedAt: "2026-10-15T23:35:00.000Z",
  status: "started",
  cause: null,
  ownerThreadId: null,
  run: {
    runId: RunId.make("run-2"),
    status: "running",
    terminal: false,
    queueHeld: false,
    requestedAt: "2026-10-16T02:32:42.954Z",
    startedAt: "2026-10-16T02:32:48.328Z",
    completedAt: null,
  },
};
const previous = {
  sendId: "original",
  recipientThreadId: "target",
  environment: "dev-vm",
  createdAt: receipt.acceptedAt,
  duplicateSend: metadata,
  receipt,
};
const input = {
  previous,
  metadata,
  environment: "dev-vm",
  now: Date.parse("2026-10-16T02:33:41.616Z"),
};

describe("duplicate send decision", () => {
  it("refuses the Oct 15 held-original released at 02:32:42.954, started at 02:32:48.328, resent at 02:33:41.616", () => {
    // Original time is only known as ~23:3x; 23:35 is a representative point in that interval.
    // The local receipt was held until release; existing lookup supplies this exact run binding.
    expect(duplicateSendCandidate(input) && duplicateSendState(receipt) !== null).toBe(true);
  });
});

describe("send normalization", () => {
  it("trims and collapses JS whitespace including Unicode without changing case", () => {
    expect(duplicateSendHash("target", " \ncontinue\t the\u00a0follow-up\r\n")).toBe(metadata.hash);
    expect(duplicateSendHash("target", "Continue the follow-up")).not.toBe(metadata.hash);
    expect(duplicateSendHash("other", "continue the follow-up")).not.toBe(metadata.hash);
    expect(duplicateSendHash("a", "b,c")).not.toBe(duplicateSendHash("a,b", "c"));
  });
});

describe("state-based decision table", () => {
  it.each([0, 29, 30, 31, 180, 1440 * 30])(
    "matches an active original at age %i minutes",
    (minutes) => {
      expect(
        duplicateSendCandidate({
          ...input,
          previous: { ...previous, createdAt: new Date(input.now - minutes * 60000).toISOString() },
        }),
      ).toBe(true);
    },
  );
  it.each(["held", "queued", "started", "steered", "accepted"] as const)(
    "refuses %s with unknown run",
    (status) => {
      expect(duplicateSendState({ ...receipt, status, run: null })).toContain(
        "treated as not terminal",
      );
    },
  );
  it.each(["completed", "failed", "cancelled", "interrupted"])(
    "allows terminal %s immediately",
    (status) => {
      expect(
        duplicateSendState({ ...receipt, run: { ...receipt.run!, status, terminal: true } }),
      ).toBeNull();
    },
  );
  it.each(["refused", "superseded", "cancelled"] as const)("allows delivery state %s", (status) => {
    expect(duplicateSendState({ ...receipt, status })).toBeNull();
  });
  it.each([
    { force: true },
    { sendId: "original" },
    { coalesceKey: "progress" },
    { metadata: { ...metadata, hash: duplicateSendHash("target", "different") } },
    { metadata: { ...metadata, hash: duplicateSendHash("different", "continue the follow-up") } },
    { metadata: { ...metadata, senderThreadId: "other-sender" } },
    { environment: "other-host" },
    { previous: { ...previous, duplicateSend: undefined } },
  ])("allows bypass, retry or unrelated intent %j", (override) => {
    expect(duplicateSendCandidate({ ...input, ...override })).toBe(false);
  });
});
