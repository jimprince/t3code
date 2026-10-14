import { describe, expect, it, vi } from "vite-plus/test";

// Set before any module builds a date formatter: this file runs the whole suite in Brad's zone.
vi.hoisted(() => {
  process.env.TZ = "America/Edmonton";
});

import { formatEta, formatEtaDay } from "./dashboard.logic";

describe("a due date near local midnight in America/Edmonton", () => {
  // 05:30Z on Oct 16 is 23:30 on Oct 15 in Edmonton (UTC-6 in October).
  const now = Date.parse("2026-10-16T05:30:00.000Z");

  it("runs in the zone it claims", () => {
    expect(new Date(now).getDate()).toBe(15);
  });

  it.each(["2026-10-16", "2026-10-16T00:00:00Z"])("renders %s as Oct 16", (eta) => {
    expect(formatEtaDay(eta, now)).toBe("Oct 16");
    expect(formatEta(eta, true, now)).toBe("Oct 16");
  });
});
