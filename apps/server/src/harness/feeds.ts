// @effect-diagnostics nodeBuiltinImport:off -- Bounded descriptor reads and O_NOFOLLOW enforce the owner-feed boundary.
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import {
  EnvironmentId,
  IsoDateTime,
  type HarnessRoutine,
  type HarnessRun,
  type HarnessSource,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as DateTime from "effect/DateTime";
import { routine, threadLink } from "./model.ts";

export const FEED_FILES = [
  "health.json",
  "detection-readback.json",
  "canary-policy.json",
  "canary-state.json",
  "canary-tick-readback.json",
  "availability.json",
  "run-receipts.json",
] as const;
export type FeedFile = (typeof FEED_FILES)[number];
const MAX_BYTES = 2 * 1024 * 1024;
const ObjectJson = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown));
const decodeObject = Schema.decodeUnknownSync(ObjectJson);
const object = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const array = (value: unknown): readonly unknown[] => (Array.isArray(value) ? value : []);
const string = (value: unknown): string | null => (typeof value === "string" ? value : null);
const timestamp = (value: unknown): string | null => {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(value) ||
    !Number.isFinite(Date.parse(value))
  )
    return null;
  return DateTime.formatIso(DateTime.makeUnsafe(value));
};
export interface FeedRead {
  readonly source: HarnessSource;
  readonly value: Record<string, unknown> | null;
}

/** Fixed names, bounded reads, and no symlink traversal, including intermediate directories. */
export async function readFeed(
  directory: string | null,
  filename: string,
  readAt: string,
  staleMs: number,
): Promise<FeedRead> {
  const source: HarnessSource = {
    key: filename,
    readAt,
    observedAt: null,
    status: directory === null ? "not-configured" : "unavailable",
    evidence: "Feed directory is not configured.",
  };
  if (!FEED_FILES.includes(filename as FeedFile))
    return {
      source: { ...source, status: "refused", evidence: "Filename is outside the allowlist." },
      value: null,
    };
  if (directory === null) return { source, value: null };
  try {
    const root = await NodeFSP.realpath(directory);
    const candidate = NodePath.join(root, filename);
    const real = await NodeFSP.realpath(candidate);
    if (real !== candidate || NodePath.dirname(real) !== root)
      return {
        source: {
          ...source,
          status: "refused",
          evidence: "Feed symlink or path outside configured directory refused.",
        },
        value: null,
      };
    const file = await NodeFSP.open(
      candidate,
      NodeFS.constants.O_RDONLY | NodeFS.constants.O_NOFOLLOW,
    );
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > MAX_BYTES)
        return {
          source: {
            ...source,
            status: "refused",
            evidence: "Feed is not a regular file within the size limit.",
          },
          value: null,
        };
      const buffer = Buffer.alloc(MAX_BYTES + 1);
      let bytesRead = 0;
      while (bytesRead <= MAX_BYTES) {
        const chunk = await file.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead);
        if (chunk.bytesRead === 0) break;
        bytesRead += chunk.bytesRead;
      }
      if (bytesRead > MAX_BYTES)
        return {
          source: { ...source, status: "refused", evidence: "Feed exceeds size limit." },
          value: null,
        };
      const value = decodeObject(buffer.toString("utf8", 0, bytesRead));
      const routeTimes = Object.values(object(value.routes))
        .map((route) => timestamp(object(route).checked_at))
        .filter((at): at is string => at !== null)
        .sort();
      const observedAt =
        timestamp(
          value.generated_at ??
            value.checked_at ??
            value.observedAt ??
            value.accepted_at ??
            value.updated_at,
        ) ??
        routeTimes.at(-1) ??
        null;
      if (observedAt === null)
        return {
          source: { ...source, evidence: "Invalid or missing owner observation timestamp." },
          value: null,
        };
      const age = Date.parse(readAt) - Date.parse(observedAt);
      return {
        source: {
          ...source,
          observedAt,
          status: age > staleMs || age < -60_000 ? "stale" : "available",
          evidence:
            age < -60_000
              ? "Owner timestamp is in the future."
              : `Owner observation age ${Math.max(0, age)} ms; freshness allowance ${staleMs} ms.`,
        },
        value,
      };
    } finally {
      await file.close();
    }
  } catch {
    return {
      source: { ...source, evidence: "Feed missing, unreadable, or invalid JSON/schema." },
      value: null,
    };
  }
}

export const FindingsReceipt = Schema.Struct({
  routineKey: Schema.String,
  runKey: Schema.String,
  observedAt: IsoDateTime,
  findingsCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  coverage: Schema.Literal("complete"),
});
const decodeFindingsReceipt = Schema.decodeUnknownOption(FindingsReceipt);
export function findingsReceipts(feed: FeedRead | undefined): ReadonlyMap<string, number> {
  const receipts = new Map<string, number>();
  if (feed?.source.status !== "available") return receipts;
  for (const entry of array(feed.value?.receipts).slice(0, 2000)) {
    const decoded = decodeFindingsReceipt(entry);
    if (
      decoded._tag === "Some" &&
      Date.parse(decoded.value.observedAt) <= Date.parse(feed.source.readAt)
    )
      receipts.set(
        `${decoded.value.routineKey}\0${decoded.value.runKey}`,
        decoded.value.findingsCount,
      );
  }
  return receipts;
}

const ProbeRun = Schema.Struct({
  id: Schema.String,
  providerInstanceId: Schema.String,
  requestedAt: IsoDateTime,
  startedAt: Schema.optionalKey(Schema.NullOr(IsoDateTime)),
  completedAt: Schema.optionalKey(Schema.NullOr(IsoDateTime)),
  status: Schema.String,
  user_message_id: Schema.optionalKey(Schema.String),
});
const decodeProbeRun = Schema.decodeUnknownOption(ProbeRun);
export function feedRoutines(
  feeds: ReadonlyMap<FeedFile, FeedRead>,
  environmentId: EnvironmentId,
  hosts: Readonly<Record<string, EnvironmentId>>,
  limit: number,
): HarnessRoutine[] {
  const rows: HarnessRoutine[] = [];
  for (const [filename, name, checks] of [
    ["health.json", "Reliability health", "Host, provider, release and resource readbacks"],
    ["detection-readback.json", "Reliability detection", "Logs, disks and server observations"],
    ["availability.json", "Head availability", "Owner availability observations"],
  ] as const) {
    const feed = feeds.get(filename)!;
    const observed = feed.source.observedAt;
    const value = feed.value;
    const observations = value
      ? ["hosts", "providers", "heads", "server_wide", "logs", "disks", "release", "resources"]
          .flatMap((section) => {
            const sectionValue = value[section];
            return (
              Array.isArray(sectionValue)
                ? sectionValue
                : sectionValue && typeof sectionValue === "object"
                  ? [sectionValue]
                  : []
            )
              .slice(0, 100)
              .flatMap((entry, index) => {
                const item = object(entry);
                const state = string(item.status ?? item.state ?? item.read);
                if (!state) return [];
                return [
                  {
                    key: `${section}:${string(item.host ?? item.threadId ?? item.account ?? item.name) ?? index}`,
                    state,
                    observedAt: timestamp(item.checked_at ?? item.observedAt) ?? observed,
                    evidence: (
                      string(item.detail ?? item.reason) ??
                      "Owner status observation; no execution/findings receipt."
                    ).slice(0, 2000),
                  },
                ];
              });
          })
          .slice(0, 100)
      : [];
    const states = [value?.status, value?.state, ...observations.map((sample) => sample.state)];
    const failing = states.some(
      (state) =>
        typeof state === "string" &&
        ["failed", "error", "critical", "down", "unavailable"].includes(state),
    );
    // Observation timestamps are evidence, not fabricated model-run outcomes or findings counts.
    rows.push(
      routine({
        key: `${environmentId}:feed:${filename}`,
        name,
        whatItChecks: checks,
        observations,
        environmentId,
        source: filename,
        purpose: "harness",
        state: !value ? "not shown yet" : failing ? "failing" : "unknown",
        sourceStale: feed.source.status !== "available",
        scheduleOrTrigger: "Owner feed; no typed unconditional schedule receipt",
        history:
          observed && value
            ? [
                {
                  key: observed,
                  requestedAt: observed,
                  expectedAt: null,
                  startedAt: null,
                  finishedAt: null,
                  outcome: failing ? "failed" : "unknown",
                  outcomeKind: "observation",
                  dryRun: false,
                  errorCount: null,
                  runtimeErrorCount: null,
                  evidence: "Owner observation; no exact execution or findings receipt.",
                  threads: [],
                },
              ]
            : [],
      }),
    );
  }
  const policy = feeds.get("canary-policy.json")!;
  const state = feeds.get("canary-state.json")!;
  const tick = feeds.get("canary-tick-readback.json")!;
  const routes = object(state.value?.routes);
  if (array(policy.value?.routes).length === 0)
    rows.push(
      routine({
        key: `${environmentId}:feed:canary-probes`,
        name: "Canary probes: not shown yet",
        environmentId,
        source: "canary-policy.json",
        purpose: "harness",
        sourceStale: true,
        state: "not shown yet",
        scheduleOrTrigger: "No admitted route policy feed",
      }),
    );
  for (const entry of array(policy.value?.routes).slice(0, 100)) {
    const route = object(entry);
    const host = string(route.host),
      account = string(route.account),
      threadId = string(route.threadId);
    if (!host || !account || !threadId) continue;
    const key = `canary:${host}:${account}`;
    const observedRoute = object(routes[`${host}:${account}`]);
    const readback = object(observedRoute.readback);
    const linked =
      observedRoute.threadId === threadId &&
      readback.thread === threadId &&
      readback.account === account &&
      readback.account_exact === true;
    const routeTime = timestamp(readback.checked_at ?? observedRoute.checked_at);
    const scopedEnvironment = Object.hasOwn(hosts, host) ? hosts[host] : undefined;
    const history: HarnessRun[] = [];
    if (linked)
      for (const probe of array(readback.runs)) {
        const parsed = decodeProbeRun(probe);
        if (parsed._tag === "None" || parsed.value.providerInstanceId !== account) continue;
        const run = parsed.value;
        const outcome: HarnessRun["outcome"] = [
          "completed",
          "failed",
          "interrupted",
          "cancelled",
        ].includes(run.status)
          ? (run.status as HarnessRun["outcome"])
          : ["preparing", "queued", "starting", "running", "waiting"].includes(run.status)
            ? "running"
            : "unknown";
        history.push({
          key: run.id,
          expectedAt: null,
          requestedAt: run.requestedAt,
          startedAt: run.startedAt ?? null,
          finishedAt: run.completedAt ?? null,
          outcome,
          outcomeKind: "execution",
          dryRun: false,
          errorCount: null,
          runtimeErrorCount: null,
          evidence: "Exact route/thread readback; detector streak is not errors per run.",
          threads: scopedEnvironment
            ? [threadLink(scopedEnvironment, threadId, run.id, run.user_message_id ?? null)]
            : [],
        });
      }
    history.sort((a, b) => b.requestedAt.localeCompare(a.requestedAt));
    const plan = array(tick.value?.plans)
      .map(object)
      .find((plan) => plan.host === host && plan.account === account && plan.threadId === threadId);
    const stale =
      policy.source.status !== "available" ||
      state.source.status !== "available" ||
      tick.source.status !== "available" ||
      routeTime === null ||
      Date.parse(state.source.readAt) - Date.parse(routeTime) > 300_000;
    const active = linked && typeof readback.activeRunId === "string";
    rows.push(
      routine({
        key,
        agentKey: key,
        name: `${host} / ${account} canary`,
        environmentId: scopedEnvironment ?? environmentId,
        owner: scopedEnvironment ? threadLink(scopedEnvironment, threadId) : null,
        purpose: "harness",
        source: "canary-state.json",
        sourceStale: stale,
        state:
          policy.value?.enabled === false
            ? "disabled"
            : observedRoute.status === "failed"
              ? "failing"
              : policy.value?.enabled === true
                ? "enabled"
                : "unknown",
        lifecycle: "standing",
        context: "persistent",
        liveness: stale || !linked ? "unknown" : active ? "active" : "not currently live",
        scheduleOrTrigger: `Conditional account freshness probe; plan ${string(plan?.action) ?? "unknown"}; cadence ${typeof plan?.cadence_seconds === "number" ? plan.cadence_seconds : "unknown"} seconds${scopedEnvironment ? "" : "; host environment mapping unavailable"}`,
        history: history.slice(0, limit),
        activeRuns: history.filter((run) => run.outcome === "running"),
        lateness: {
          state: policy.value?.enabled === false ? "disabled" : stale ? "unknown" : "event-driven",
          overdue: policy.value?.enabled === false ? false : null,
          since: null,
          latenessMs: null,
          graceMs: 0,
          missedSlots: null,
          sampleSize: history.length,
          coverage: "unknown",
          evidence: "Natural starts can suppress probes; no unconditional overdue assertion.",
        },
      }),
    );
  }
  rows.push(
    routine({
      key: `${environmentId}:watchdog:240`,
      name: "#240 watchdog W: DISABLED",
      environmentId,
      source: "registry",
      purpose: "harness",
      state: "disabled",
      scheduleOrTrigger: "Disabled by owner; no state file expected",
      lateness: {
        state: "disabled",
        overdue: false,
        since: null,
        latenessMs: null,
        graceMs: 0,
        missedSlots: null,
        sampleSize: 0,
        coverage: "complete",
        evidence: "Explicit owner decision: #240 watchdog W disabled.",
      },
    }),
  );
  for (const [key, name] of [
    ["ci-repair:github:jimprince/t3code:Sync Upstream", "CI repair bot"],
    [`${environmentId}:unadmitted-checks`, "Other bots, cron and timers"],
  ])
    rows.push(
      routine({
        key: key!,
        name: name!,
        environmentId,
        source: "registry",
        purpose: "harness",
        state: "not shown yet",
        scheduleOrTrigger: "Not shown yet: no typed owner execution receipt",
      }),
    );
  return rows;
}
