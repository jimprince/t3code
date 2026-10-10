import { afterAll, beforeAll, describe, expect, it, vi } from "vite-plus/test";

import { decisionSortTime, decisionVisibility } from "./decisionDeferral.ts";

const at = (value: string) => Date.parse(value);

beforeAll(() => {
  vi.stubEnv("TZ", "America/Edmonton");
});
afterAll(() => {
  vi.unstubAllEnvs();
});

describe("decisionVisibility", () => {
  it("shows a card nobody deferred, and one whose time has passed", () => {
    expect(decisionVisibility({ now: at("2026-10-08T00:00:00Z") }).hidden).toBe(false);
    const past = { until: "2026-10-07T00:00:00.000Z", movedToEndAt: null };
    expect(decisionVisibility({ deferral: past, now: at("2026-10-08T00:00:00Z") })).toEqual({
      hidden: false,
      returnsAt: null,
      forDeadline: false,
    });
  });

  it("hides a card until the chosen time", () => {
    const deferral = { until: "2026-10-09T15:00:00.000Z", movedToEndAt: null };
    expect(decisionVisibility({ deferral, now: at("2026-10-08T00:00:00Z") })).toEqual({
      hidden: true,
      returnsAt: "2026-10-09T15:00:00.000Z",
      forDeadline: false,
    });
  });

  it("brings a card back at the start of the local day before its deadline, and says so", () => {
    const deferral = { until: "2026-10-20T00:00:00.000Z", movedToEndAt: null };
    const early = decisionVisibility({
      deferral,
      deadline: "2026-10-08",
      now: at("2026-10-05T00:00:00Z"),
    });
    expect(early).toEqual({
      hidden: true,
      returnsAt: "2026-10-07T06:00:00.000Z",
      forDeadline: true,
    });

    // 18:00 on Oct 6 in Edmonton is midnight UTC: not yet the day before.
    expect(
      decisionVisibility({ deferral, deadline: "2026-10-08", now: at("2026-10-07T00:00:00Z") })
        .hidden,
    ).toBe(true);
    const back = decisionVisibility({
      deferral,
      deadline: "2026-10-08",
      now: at("2026-10-07T06:00:00Z"),
    });
    expect(back.hidden).toBe(false);
    expect(back.forDeadline).toBe(true);
  });

  it("does not blame the deadline when the chosen time comes first", () => {
    const deferral = { until: "2026-10-06T00:00:00.000Z", movedToEndAt: null };
    expect(
      decisionVisibility({
        deferral,
        deadline: "2026-10-08",
        now: at("2026-10-05T00:00:00Z"),
      }).forDeadline,
    ).toBe(false);
  });

  it("moving to the end alone never hides a card", () => {
    const deferral = { until: null, movedToEndAt: "2026-10-08T00:00:00.000Z" };
    expect(decisionVisibility({ deferral, now: at("2026-10-08T01:00:00Z") }).hidden).toBe(false);
  });
});

describe("decisionSortTime", () => {
  it("sorts a moved card by when it moved, and an unmoved one by when it was filed", () => {
    const filed = "2026-10-01T00:00:00.000Z";
    expect(decisionSortTime(filed)).toBe(at(filed));
    expect(decisionSortTime(filed, { until: null, movedToEndAt: "2026-10-08T00:00:00.000Z" })).toBe(
      at("2026-10-08T00:00:00.000Z"),
    );
  });
});
