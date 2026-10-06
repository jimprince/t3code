import { expect, it } from "vite-plus/test";
import { processLaunchesLastMinute, recordProcessLaunch } from "./processLaunchDiagnostics.ts";

it("counts actual launch attempts by executable and expires old buckets", () => {
  recordProcessLaunch(100_000, "diagnostics-test-gh", "attempted");
  recordProcessLaunch(100_000, "diagnostics-test-gh", "spawned");
  recordProcessLaunch(101_000, "diagnostics-test-gh", "attempted");
  recordProcessLaunch(101_000, "diagnostics-test-gh", "failed");
  expect(processLaunchesLastMinute(159_000)["diagnostics-test-gh"]).toEqual({
    attempted: 2,
    spawned: 1,
    failed: 1,
  });
  expect(processLaunchesLastMinute(160_000)["diagnostics-test-gh"]).toEqual({
    attempted: 1,
    spawned: 0,
    failed: 1,
  });
  expect(processLaunchesLastMinute(161_000)["diagnostics-test-gh"]).toBeUndefined();
});

it("bounds executable cardinality without losing attempt totals", () => {
  const now = 9_000_000;
  for (let i = 0; i < 1000; i++) recordProcessLaunch(now, `unique-${i}`, "attempted");
  const rates = processLaunchesLastMinute(now);
  expect(Object.keys(rates).length).toBeLessThanOrEqual(129);
  expect(Object.values(rates).reduce((total, value) => total + value.attempted, 0)).toBe(1000);
});
