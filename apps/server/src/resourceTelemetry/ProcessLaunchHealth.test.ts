import { describe, expect, it } from "vite-plus/test";
import { DEFAULT_SERVER_SETTINGS } from "@t3tools/contracts";
import { ProcessLaunchHealthEvaluator } from "./ProcessLaunchHealth.ts";

const settings = DEFAULT_SERVER_SETTINGS.processLaunchWarnings;
const mib = 1024 * 1024;
const sample = (at: number, rss: number, pid = 10) => ({
  sampledAtUnixMs: at,
  pid,
  startTimeMs: 100,
  residentBytes: rss * mib,
  cpuPercent: 20,
});
const input = (at: number, rss = 100, attempts = 0, pid = 10) => ({
  nowMs: at,
  sampledAtUnixMs: at,
  syspolicyd: sample(at, rss, pid),
  attemptsPerMinute: attempts,
  failuresPerMinute: 2,
  settings,
});

describe("process launch health", () => {
  it("warns only above the configurable RSS threshold and clears on recovery", () => {
    const evaluator = new ProcessLaunchHealthEvaluator();
    expect(evaluator.evaluate(input(0, 1024)).warnings).toEqual([]);
    const health = evaluator.evaluate(input(60_000, 1025));
    expect(health.warnings[0]).toContain("sudo killall syspolicyd ONCE");
    expect(health.warnings[0]).toContain("Repeated kills");
    expect(evaluator.evaluate(input(120_000)).warnings).toEqual([]);
    expect(
      evaluator.evaluate({
        ...input(180_000, 101),
        settings: { ...settings, syspolicydRssMb: 100 },
      }).warnings,
    ).toHaveLength(1);
  });
  it("detects growth within ten minutes, but not across daemon restarts or missing reads", () => {
    const evaluator = new ProcessLaunchHealthEvaluator();
    evaluator.evaluate(input(0));
    for (let at = 60_000; at < 600_000; at += 60_000) evaluator.evaluate(input(at));
    expect(evaluator.evaluate(input(600_000, 401)).warnings[0]).toContain("grew");
    expect(evaluator.evaluate(input(660_000, 900, 0, 11)).warnings).toEqual([]);
    evaluator.evaluate({ ...input(720_000), syspolicyd: null });
    expect(evaluator.evaluate(input(780_000, 900, 0, 11)).warnings).toEqual([]);
  });
  it("requires a sustained minute of high attempts and resets after recovery or a sampling gap", () => {
    const evaluator = new ProcessLaunchHealthEvaluator();
    expect(evaluator.evaluate(input(0, 100, 601)).warnings).toEqual([]);
    expect(evaluator.evaluate(input(60_000, 100, 601)).warnings[0]).toContain("sustained minute");
    expect(evaluator.evaluate(input(120_000, 100, 600)).warnings).toEqual([]);
    expect(evaluator.evaluate(input(180_000, 100, 601)).warnings).toEqual([]);
    expect(evaluator.evaluate(input(300_000, 100, 601)).warnings).toEqual([]);
    expect(evaluator.evaluate(input(0, 100, 601)).warnings).toEqual([]);
  });
  it("keeps runner coverage when syspolicyd is unavailable", () => {
    const evaluator = new ProcessLaunchHealthEvaluator();
    evaluator.evaluate({ ...input(0, 100, 700), syspolicyd: null });
    expect(
      evaluator.evaluate({ ...input(60_000, 100, 700), syspolicyd: null }).warnings,
    ).toHaveLength(1);
  });
});
