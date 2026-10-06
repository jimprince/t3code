import { describe, expect, it } from "vite-plus/test";
import type { OrchestrationV2ThreadProjection } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { legacyNoticeCanStart } from "./LegacyBackgroundWorkPolicy.ts";
import { stoppedBackgroundWorkNotice } from "./LegacyBackgroundWorkImport.ts";
const time = DateTime.makeUnsafe("2026-10-05T00:00:00Z");
function projection(overrides: object = {}) {
  return {
    thread: {
      updatedAt: time,
      archivedAt: null,
      deletedAt: null,
      settledOverride: null,
      snoozedUntil: null,
    },
    runtimeRequests: [],
    runs: [],
    ...overrides,
  } as unknown as OrchestrationV2ThreadProjection;
}
describe("legacy background notice serialized acceptance", () => {
  it("permits an idle imported thread once its recorded update still matches", () => {
    expect(legacyNoticeCanStart(projection(), time)).toBe(true);
    expect(legacyNoticeCanStart(projection(), DateTime.makeUnsafe("2026-10-05T00:00:01Z"))).toBe(
      false,
    );
  });
  it.each([
    "preparing",
    "queued",
    "starting",
    "running",
    "waiting",
    "interrupted",
    "failed",
    "cancelled",
  ])("never restarts %s work", (status) => {
    expect(legacyNoticeCanStart(projection({ runs: [{ ordinal: 1, status }] }), time)).toBe(false);
  });
  it.each([
    { archivedAt: time },
    { deletedAt: time },
    { settledOverride: "settled" },
    { snoozedUntil: time },
  ])("respects explicit terminal state %j", (state) => {
    const current = projection();
    expect(
      legacyNoticeCanStart(
        { ...current, thread: { ...current.thread, ...state } } as OrchestrationV2ThreadProjection,
        time,
      ),
    ).toBe(false);
  });
  it("blocks pending approval and preserves stopped run even with unsorted history", () => {
    expect(
      legacyNoticeCanStart(projection({ runtimeRequests: [{ status: "pending" }] }), time),
    ).toBe(false);
    expect(
      legacyNoticeCanStart(
        projection({
          runs: [
            { ordinal: 2, status: "interrupted" },
            { ordinal: 1, status: "completed" },
          ],
        }),
        time,
      ),
    ).toBe(false);
  });
  it("bounds actionable notices without dropping task identities", () => {
    const notice = stoppedBackgroundWorkNotice(
      Array.from({ length: 23 }, (_, i) => ({
        taskId: String(i),
        kind: "monitor" as const,
        description: "x".repeat(400),
      })),
    );
    expect(notice.match(/Monitor:/g)).toHaveLength(20);
    expect(notice).toContain("and 3 more");
    expect(notice).toContain("Relaunch each one now");
    expect(notice).not.toContain("x".repeat(201));
  });
});
