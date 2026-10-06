/** Direct ProcessRunner spawn calls only; no argv, paths, or subprocess sampling. */
const buckets = new Map<
  number,
  Map<string, { attempted: number; spawned: number; failed: number }>
>();

export function recordProcessLaunch(
  nowMs: number,
  executable: string,
  outcome: "attempted" | "spawned" | "failed",
) {
  const second = Math.floor(nowMs / 1_000);
  for (const key of buckets.keys()) if (key <= second - 60) buckets.delete(key);
  const bucket = buckets.get(second) ?? new Map();
  const boundedExecutable = bucket.has(executable) || bucket.size < 128 ? executable : "<other>";
  const counts = bucket.get(boundedExecutable) ?? { attempted: 0, spawned: 0, failed: 0 };
  counts[outcome]++;
  bucket.set(boundedExecutable, counts);
  buckets.set(second, bucket);
}

export function processLaunchesLastMinute(nowMs: number) {
  const second = Math.floor(nowMs / 1_000);
  const totals = new Map<string, { attempted: number; spawned: number; failed: number }>();
  for (const [key, bucket] of buckets) {
    if (key <= second - 60 || key > second) continue;
    for (const [executable, count] of bucket) {
      const total = totals.get(executable) ?? { attempted: 0, spawned: 0, failed: 0 };
      total.attempted += count.attempted;
      total.spawned += count.spawned;
      total.failed += count.failed;
      totals.set(executable, total);
    }
  }
  return Object.fromEntries(totals);
}
