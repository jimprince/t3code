import { useFocusEffect } from "@react-navigation/native";
import {
  buildHarnessAgents,
  buildHarnessChecks,
  buildHarnessRunRows,
  describeHarnessAgent,
  describeHarnessFreshness,
  staleHarnessSources,
  type HarnessAgentBucket,
  type HarnessAgentView,
  type HarnessCheckView,
  type HarnessTone,
} from "@t3tools/client-runtime/state/harness-view";
import type {
  OrchestratorSummary,
  OrchestratorThreadShell,
} from "@t3tools/client-runtime/state/orchestrators";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { formatLocalWhen } from "@t3tools/shared/localTime";
import { useEffect, useMemo, useState } from "react";
import { Pressable, ScrollView, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { EmptyState } from "../../components/EmptyState";
import { cn } from "../../lib/cn";
import { useHarnessEnvironments } from "../../state/harness";

type OpenThread = (thread: Pick<EnvironmentThreadShell, "environmentId" | "id">) => void;

const DOT: Record<HarnessAgentBucket, string> = {
  failed: "bg-red-500",
  "needs-you": "bg-warning-foreground",
  working: "bg-adaptive-sky-600-400",
  idle: "bg-foreground-muted",
};
const AGENT_TONE = {
  error: "text-destructive",
  warning: "text-warning-foreground",
  info: "text-adaptive-sky-600-400",
} as const;
const TONE_TEXT: Record<HarnessTone, string> = {
  error: "text-destructive",
  warning: "text-warning-foreground",
  muted: "text-foreground-muted",
  ok: "text-foreground",
};
const TONE_DOT: Record<HarnessTone, string> = {
  error: "bg-red-500",
  warning: "bg-warning-foreground",
  muted: "bg-foreground-muted",
  ok: "bg-emerald-500",
};

function AgentRow({
  agent,
  now,
  onOpen,
}: {
  readonly agent: HarnessAgentView;
  readonly now: number;
  readonly onOpen: OpenThread;
}) {
  const right = describeHarnessAgent(agent);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Open ${agent.thread.title}`}
      className="min-h-11 flex-row items-center gap-2 border-b border-border px-2 active:bg-card"
      onPress={() => onOpen(agent.thread)}
    >
      <View className={cn("h-2 w-2 rounded-full", DOT[agent.bucket])} />
      <Text className="min-w-0 flex-1 text-sm text-foreground" numberOfLines={1}>
        {agent.thread.title}
      </Text>
      {right ? <Text className={cn("text-xs", AGENT_TONE[right.tone])}>{right.text}</Text> : null}
      <Text className="text-xs text-foreground-muted">
        {formatLocalWhen(Date.parse(agent.latestActivityAt), now)}
      </Text>
    </Pressable>
  );
}

function CheckRow({
  check,
  now,
  expanded,
  onToggle,
  onOpen,
}: {
  readonly check: HarnessCheckView;
  readonly now: number;
  readonly expanded: boolean;
  readonly onToggle: () => void;
  readonly onOpen: OpenThread;
}) {
  const { errors } = check;
  const classification = [check.lifecycleLabel, check.contextLabel, check.schedule]
    .filter((part) => part !== null && part !== "")
    .join(" · ");
  const timing = [
    check.lastRunLabel ? `last ${check.lastRunLabel}` : "no run yet",
    check.nextLabel ? `next ${check.nextLabel}` : null,
    check.livenessLabel,
  ]
    .filter((part) => part !== null)
    .join(" · ");
  const runs = expanded ? buildHarnessRunRows(check.routine, now) : [];
  return (
    <View className="border-b border-border">
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${check.name}, ${check.stateLabel}`}
        accessibilityState={{ expanded }}
        className="min-h-11 gap-0.5 px-2 py-2 active:bg-card"
        onPress={onToggle}
      >
        <View className="flex-row items-center gap-2">
          <View className={cn("h-2 w-2 rounded-full", TONE_DOT[check.tone])} />
          <Text className="min-w-0 flex-1 text-sm text-foreground" numberOfLines={1}>
            {check.name}
          </Text>
          <Text className={cn("text-xs", TONE_TEXT[check.tone])}>
            {check.latenessLabel ?? check.stateLabel}
          </Text>
        </View>
        <Text className="pl-4 text-xs text-foreground-muted" numberOfLines={1}>
          {classification}
        </Text>
        <View className="flex-row gap-2 pl-4">
          <Text className="min-w-0 flex-1 text-xs text-foreground-muted" numberOfLines={1}>
            {timing}
          </Text>
          <Text
            className={cn(
              "text-xs",
              errors.everyRun ? "text-warning-foreground" : "text-foreground-muted",
            )}
          >
            {`errors ${errors.label}${errors.known && errors.trend ? ` (${errors.trend})` : ""}`}
          </Text>
        </View>
      </Pressable>
      {expanded ? (
        <View className="gap-1 px-2 pb-2">
          <Text className="text-xs text-foreground">{check.evidence}</Text>
          {check.whatItChecks ? (
            <Text className="text-xs text-foreground-muted">{check.whatItChecks}</Text>
          ) : null}
          <Text className="text-xs text-foreground-muted">
            {`Findings per run: ${errors.known ? errors.label : "unknown (no run reported a count)"}${errors.failedLabel ? ` · ${errors.failedLabel}` : ""}`}
          </Text>
          {runs.length === 0 ? (
            <Text className="text-xs text-foreground-muted">No runs retained.</Text>
          ) : (
            runs.map((run) => (
              <View key={run.key} className="min-h-11 flex-row items-center gap-2">
                <Text className="w-24 text-xs text-foreground-muted">{run.timeLabel}</Text>
                <Text
                  className={cn(
                    "min-w-0 flex-1 text-xs",
                    run.failed ? "text-destructive" : "text-foreground-muted",
                  )}
                  numberOfLines={1}
                >
                  {run.outcomeLabel}
                </Text>
                <Text className="text-xs text-foreground-muted">{run.errorsLabel}</Text>
                {run.thread ? (
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={`Open run of ${check.name} at ${run.timeLabel}`}
                    className="min-h-11 justify-center px-2"
                    onPress={() =>
                      run.thread &&
                      onOpen({ environmentId: run.thread.environmentId, id: run.thread.threadId })
                    }
                  >
                    <Text className="text-xs text-adaptive-sky-600-400">Open</Text>
                  </Pressable>
                ) : (
                  <Text className="w-12 text-right text-xs text-foreground-muted">none</Text>
                )}
              </View>
            ))
          )}
        </View>
      ) : null}
    </View>
  );
}

/**
 * The Harness tab on the phone, read-only: the Harness roots, then the automated checks with their
 * schedule, lateness and findings per run. Mirrors the web list through the same client-runtime
 * view model. Run history opens inline; Move to Harness stays a web menu action for now.
 */
export function MobileHarnessList({
  harnessRoots,
  onSelectThread,
}: {
  readonly harnessRoots: ReadonlyArray<OrchestratorSummary | OrchestratorThreadShell>;
  readonly onSelectThread: OpenThread;
}) {
  const { environments, refresh } = useHarnessEnvironments();
  const [idleExpanded, setIdleExpanded] = useState(false);
  const [expandedCheck, setExpandedCheck] = useState<string | null>(null);
  // Read again each time the tab regains focus; the query's own interval covers the time between.
  useFocusEffect(refresh);
  const agents = useMemo(() => buildHarnessAgents(harnessRoots), [harnessRoots]);
  const attention = agents.filter((agent) => agent.bucket !== "idle");
  const idle = agents.filter((agent) => agent.bucket === "idle");
  const snapshots = useMemo(
    () => environments.flatMap(({ snapshot }) => (snapshot === null ? [] : [snapshot])),
    [environments],
  );
  // A minute clock keeps "late" and "stale" current even when polling has stopped.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  const checks = useMemo(() => buildHarnessChecks(snapshots, now), [now, snapshots]);
  const oldest = snapshots.map((snapshot) => snapshot.generatedAt).sort()[0];
  const freshness = describeHarnessFreshness(oldest ?? null, now);
  const staleSources = staleHarnessSources(snapshots);
  const count = (state: HarnessCheckView["state"]) =>
    checks.filter((check) => check.state === state).length;
  const summary = [
    count("failing") > 0 ? `${count("failing")} failing` : null,
    count("overdue") > 0 ? `${count("overdue")} overdue` : null,
    staleSources > 0 ? `${staleSources} source${staleSources === 1 ? "" : "s"} stale` : null,
  ].filter((part) => part !== null);
  const failedEnvironments = environments.filter((environment) => environment.error !== null);

  if (agents.length === 0 && environments.length === 0) {
    return (
      <View className="flex-1 items-center justify-center px-8">
        <EmptyState
          title="No Harness yet"
          detail="Move a thread to Harness from the desktop app, and connect a server that reports checks."
        />
      </View>
    );
  }
  return (
    <ScrollView className="flex-1" contentContainerClassName="px-3 pb-24">
      <Text className="px-2 pt-3 pb-1 text-xs font-t3-medium text-foreground-muted">
        {agents.length === 0 ? "AGENTS" : `AGENTS  ${attention.length} of ${agents.length} active`}
      </Text>
      {attention.map((agent) => (
        <AgentRow key={agent.key} agent={agent} now={now} onOpen={onSelectThread} />
      ))}
      {idle.length > 0 ? (
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ expanded: idleExpanded }}
          className="min-h-11 justify-center px-2 active:bg-card"
          onPress={() => setIdleExpanded((value) => !value)}
        >
          <Text className="text-xs text-foreground-muted">
            {idleExpanded ? "Hide" : "Show"} {idle.length} idle
          </Text>
        </Pressable>
      ) : null}
      {idleExpanded
        ? idle.map((agent) => (
            <AgentRow key={agent.key} agent={agent} now={now} onOpen={onSelectThread} />
          ))
        : null}

      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Read the checks again"
        className="min-h-11 flex-row items-center gap-2 px-2 pt-3"
        onPress={refresh}
      >
        <Text className="text-xs font-t3-medium text-foreground-muted">CHECKS</Text>
        {oldest === undefined ? null : (
          <Text
            className={cn(
              "text-xs",
              freshness.stale ? "text-warning-foreground" : "text-foreground-muted",
            )}
          >
            {freshness.stale ? `stale, ${freshness.label}` : freshness.label}
          </Text>
        )}
        <Text className="min-w-0 flex-1 text-right text-xs text-foreground-muted" numberOfLines={1}>
          {summary.join(" · ")}
        </Text>
      </Pressable>
      {failedEnvironments.map((environment) => (
        <Text
          key={environment.environmentId}
          accessibilityRole="alert"
          className="px-2 py-1 text-xs text-destructive"
        >
          {`Could not load the checks on ${environment.label}${environment.snapshot ? " (showing the last read)" : ""}: ${environment.error}`}
        </Text>
      ))}
      {environments.length === 0 ? (
        <Text className="px-2 py-2 text-xs text-foreground-muted">
          No connected server reports Harness checks yet.
        </Text>
      ) : null}
      {checks.length === 0 && snapshots.length > 0 ? (
        <Text className="px-2 py-2 text-xs text-foreground-muted">
          No automated checks are registered.
        </Text>
      ) : null}
      {checks.map((check) => (
        <CheckRow
          key={check.key}
          check={check}
          now={now}
          expanded={expandedCheck === check.key}
          onToggle={() => setExpandedCheck((key) => (key === check.key ? null : check.key))}
          onOpen={onSelectThread}
        />
      ))}
    </ScrollView>
  );
}
