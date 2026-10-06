import type {
  ProcessLaunchHealth,
  ProcessLaunchWarningSettings,
  SyspolicydSample,
} from "@t3tools/contracts";

const LAUNCH_HEALTH_GUIDANCE =
  "Reduce active threads. If macOS launches still stall, run sudo killall syspolicyd ONCE in a terminal on the server Mac. Repeated kills can cause launchd to throttle the daemon and freeze WindowServer.";

/** Bounded history, same daemon identity, and clock-reset handling prevent restart/clock false alarms. */
export class ProcessLaunchHealthEvaluator {
  private history: Array<{ at: number; sample: SyspolicydSample }> = [];
  private highSpawnSince: number | undefined;
  private previousAt: number | undefined;

  evaluate(input: {
    nowMs: number;
    sampledAtUnixMs: number;
    syspolicyd: SyspolicydSample | null;
    attemptsPerMinute: number;
    failuresPerMinute: number;
    settings: ProcessLaunchWarningSettings;
  }): ProcessLaunchHealth {
    const { nowMs, settings } = input;
    const warnings: string[] = [];
    const contiguous =
      this.previousAt !== undefined && nowMs > this.previousAt && nowMs - this.previousAt <= 90_000;
    if (!contiguous) {
      this.highSpawnSince = undefined;
      this.history = [];
    }
    this.previousAt = nowMs;
    if (input.attemptsPerMinute > settings.spawnAttemptsPerMinute) {
      this.highSpawnSince ??= nowMs;
      if (nowMs - this.highSpawnSince >= 60_000)
        warnings.push(
          `T3 process-runner attempts exceed ${settings.spawnAttemptsPerMinute}/minute for a sustained minute.`,
        );
    } else {
      this.highSpawnSince = undefined;
    }
    const sample = input.syspolicyd;
    if (sample === null) {
      this.history = [];
    } else {
      this.history = this.history.filter(
        ({ at, sample: previous }) =>
          nowMs - at <= 600_000 &&
          previous.pid === sample.pid &&
          previous.startTimeMs === sample.startTimeMs,
      );
      if (sample.residentBytes > settings.syspolicydRssMb * 1024 * 1024)
        warnings.push(`syspolicyd memory exceeds ${settings.syspolicydRssMb} MiB.`);
      const baseline = this.history[0];
      if (
        baseline &&
        sample.sampledAtUnixMs !== baseline.sample.sampledAtUnixMs &&
        sample.residentBytes - baseline.sample.residentBytes >
          settings.syspolicydGrowthMb * 1024 * 1024
      )
        warnings.push(
          `syspolicyd memory grew more than ${settings.syspolicydGrowthMb} MiB within ten minutes.`,
        );
      if (this.history.at(-1)?.sample.sampledAtUnixMs !== sample.sampledAtUnixMs)
        this.history.push({ at: nowMs, sample });
      this.history = this.history.slice(-11);
    }
    return {
      sampledAtUnixMs: input.sampledAtUnixMs,
      syspolicyd: sample,
      attemptsPerMinute: input.attemptsPerMinute,
      failuresPerMinute: input.failuresPerMinute,
      warnings: warnings.map((warning) => `${warning} ${LAUNCH_HEALTH_GUIDANCE}`),
    };
  }
}
