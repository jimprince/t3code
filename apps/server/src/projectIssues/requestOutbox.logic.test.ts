import type { ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { formatRequestMarker, parseRequestMarker } from "./projectIssues.logic.ts";
import {
  EMPTY_OUTBOX,
  enqueue,
  isAlreadyFiled,
  parseOutbox,
  retryDelayMs,
  updateEntry,
  type OutboxEntry,
} from "./requestOutbox.logic.ts";

const entry = (messageId: string): OutboxEntry => ({
  messageId,
  threadId: "worker" as ThreadId,
  rootThreadId: "root" as ThreadId,
  text: "Can we connect the ReSpeaker?",
  capturedAt: "2026-10-05T00:00:00.000Z",
  items: null,
  filed: [],
  attempts: 0,
  lastError: null,
  nextAttemptAt: 0,
});

describe("request outbox", () => {
  it("queues a message once and survives a round trip through its file", () => {
    const once = enqueue(EMPTY_OUTBOX, entry("m-1"));
    expect(enqueue(once, entry("m-1")).entries).toHaveLength(1);
    expect(parseOutbox(JSON.stringify(once))).toEqual(once);
    expect(parseOutbox("not json")).toEqual(EMPTY_OUTBOX);
    expect(parseOutbox(null)).toEqual(EMPTY_OUTBOX);
  });

  it("updates or removes one entry", () => {
    const outbox = enqueue(enqueue(EMPTY_OUTBOX, entry("m-1")), entry("m-2"));
    const retried = updateEntry(outbox, "m-1", (current) => ({ ...current, attempts: 1 }));
    expect(retried.entries.map((item) => [item.messageId, item.attempts])).toEqual([
      ["m-1", 1],
      ["m-2", 0],
    ]);
    expect(updateEntry(outbox, "m-1", () => null).entries.map((item) => item.messageId)).toEqual([
      "m-2",
    ]);
  });

  it("backs off from 30 seconds to a 10 minute ceiling", () => {
    expect(retryDelayMs(1)).toBe(30_000);
    expect(retryDelayMs(2)).toBe(60_000);
    expect(retryDelayMs(20)).toBe(600_000);
  });

  it("recognises a request already filed from the same message and item", () => {
    const source = {
      threadId: "worker" as ThreadId,
      rootThreadId: "root" as ThreadId,
      messageId: "m-1",
      item: 1,
    };
    const filed = [{ requestSource: parseRequestMarker(formatRequestMarker(source)) }];
    expect(isAlreadyFiled(filed, "m-1", 1)).toBe(true);
    expect(isAlreadyFiled(filed, "m-1", 0)).toBe(false);
    expect(isAlreadyFiled(filed, "m-2", 1)).toBe(false);
    // Markers written before item indexes existed count as item 0.
    const legacy = [{ requestSource: { ...source, item: undefined } }];
    expect(isAlreadyFiled(legacy as never, "m-1", 0)).toBe(true);
  });
});
