import { describe, expect, it } from "vite-plus/test";

import type { ProjectHealth } from "@t3tools/contracts";

import { isHealthStale } from "./projectHealth.logic";

const health = (updatedAt: string): ProjectHealth => ({
  status: "at-risk",
  sentence: "V2 port waiting on plan approval",
  updatedAt,
  threadId: null,
});

describe("isHealthStale", () => {
  const now = Date.parse("2026-10-05T12:00:00.000Z");

  it("is fresh when written today after the newest work change", () => {
    expect(isHealthStale(health("2026-10-05T10:00:00.000Z"), "2026-10-05T09:00:00.000Z", now)).toBe(
      false,
    );
    expect(isHealthStale(health("2026-10-05T10:00:00.000Z"), null, now)).toBe(false);
  });

  it("is stale when older than a day", () => {
    expect(isHealthStale(health("2026-10-04T11:00:00.000Z"), null, now)).toBe(true);
  });

  it("is stale when work changed after it was written", () => {
    expect(isHealthStale(health("2026-10-05T10:00:00.000Z"), "2026-10-05T11:00:00.000Z", now)).toBe(
      true,
    );
  });
});
