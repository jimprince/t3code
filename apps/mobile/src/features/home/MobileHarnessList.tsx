import { selectHarnessQueuedSends } from "@t3tools/client-runtime/state/harness-query";
import { useFocusEffect } from "@react-navigation/native";
import {
  buildHarnessChecksList,
  harnessOwnerTitles,
} from "@t3tools/client-runtime/state/harness-checks-list";
import { harnessCheckRef } from "@t3tools/client-runtime/state/harness-check-page";
import { buildHarnessStrip } from "@t3tools/client-runtime/state/harness-strip";
import {
  buildHarnessAgents,
  buildHarnessChecks,
  describeHarnessAgent,
  describeHarnessFreshness,
  describeHarnessSources,
  spokenHarnessAgent,
  splitHarnessChecks,
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
import { useNavigation } from "@react-navigation/native";
import { useMemo, useState } from "react";
import { Pressable, ScrollView, View } from "react-native";

import { AppText as Text, AppTextInput as TextInput } from "../../components/AppText";
import { EmptyState } from "../../components/EmptyState";
import { cn } from "../../lib/cn";
import { useHarnessEnvironments, useHarnessNow } from "../../state/harness";

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
const STRIP_TONE: Record<HarnessTone, string> = {
  error: "text-destructive",
  warning: "text-warning-foreground",
  muted: "text-foreground",
  ok: "text-foreground",
};
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
      accessibilityLabel={spokenHarnessAgent(agent)}
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

/** One check: a row that opens the check's own screen. */
function CheckRow({
  check,
  onOpen,
}: {
  readonly check: HarnessCheckView;
  readonly onOpen: (check: HarnessCheckView) => void;
}) {
  const { errors } = check;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={check.spokenLabel}
      className="min-h-11 gap-0.5 border-b border-border px-2 py-2 active:bg-card"
      onPress={() => onOpen(check)}
    >
      <View className="flex-row items-center gap-2">
        <View className={cn("h-2 w-2 rounded-full", TONE_DOT[check.tone])} />
        <Text className="min-w-0 flex-1 text-sm text-foreground" numberOfLines={1}>
          {check.name}
        </Text>
        {check.pinned ? <Text className="text-xs text-foreground-muted">Pinned</Text> : null}
        <Text className={cn("text-xs", TONE_TEXT[check.tone])}>
          {check.latenessLabel ?? check.stateLabel}
        </Text>
      </View>
      <Text className="pl-4 text-xs text-foreground-muted" numberOfLines={1}>
        {check.classification}
      </Text>
      <View className="flex-row gap-2 pl-4">
        <Text className="min-w-0 flex-1 text-xs text-foreground-muted" numberOfLines={1}>
          {check.timing}
        </Text>
        {check.errorsText === null ? null : (
          <Text
            className={cn(
              "text-xs",
              errors.everyRun ? "text-warning-foreground" : "text-foreground-muted",
            )}
          >
            {check.errorsText}
          </Text>
        )}
      </View>
    </Pressable>
  );
}

/**
 * The Harness tab on the phone, read-only: the Harness roots, then the automated checks with their
 * schedule, lateness and findings per run. Mirrors the web list through the same client-runtime
 * view model. A check opens its own screen with its run history; Move to Harness stays a web
 * menu action for now.
 */
export function MobileHarnessList({
  harnessRoots,
  threads,
  onSelectThread,
}: {
  readonly harnessRoots: ReadonlyArray<OrchestratorSummary | OrchestratorThreadShell>;
  /** Every thread shell, so the filter can match a check by its owner thread's title. */
  readonly threads: ReadonlyArray<Pick<EnvironmentThreadShell, "environmentId" | "id" | "title">>;
  readonly onSelectThread: OpenThread;
}) {
  const { environments, refresh } = useHarnessEnvironments();
  const [idleExpanded, setIdleExpanded] = useState(false);
  const navigation = useNavigation();
  // Read again each time the tab regains focus; the query's own interval covers the time between.
  useFocusEffect(refresh);
  const agents = useMemo(() => buildHarnessAgents(harnessRoots), [harnessRoots]);
  const attention = agents.filter((agent) => agent.bucket !== "idle");
  const idle = agents.filter((agent) => agent.bucket === "idle");
  const snapshots = useMemo(
    () => environments.flatMap(({ snapshot }) => (snapshot === null ? [] : [snapshot])),
    [environments],
  );
  const now = useHarnessNow();
  // A host whose last refresh failed can no longer confirm its rows, however recent they are.
  const unreachable = useMemo(
    () =>
      new Set<string>(
        environments
          .filter((environment) => environment.error !== null)
          .map((environment) => environment.environmentId),
      ),
    [environments],
  );
  const pinEnabled = useMemo(
    () =>
      new Set<string>(
        environments
          .filter((environment) => environment.pinSupported)
          .map((environment) => environment.environmentId),
      ),
    [environments],
  );
  const checks = useMemo(
    () => buildHarnessChecks(snapshots, now, { unreachable, pinEnabled }),
    [now, pinEnabled, snapshots, unreachable],
  );
  const strip = useMemo(
    () =>
      buildHarnessStrip({
        snapshots,
        queuedSends: selectHarnessQueuedSends(snapshots),
        now,
        unreachable,
        missingEnvironments: environments.filter((environment) => environment.snapshot === null)
          .length,
      }),
    [environments, now, snapshots, unreachable],
  );
  // The header counts every Harness check, whatever the filter shows.
  const harnessChecks = useMemo(() => splitHarnessChecks(checks).harness, [checks]);
  const [query, setQuery] = useState("");
  const [feedsExpanded, setFeedsExpanded] = useState(false);
  const ownerTitle = useMemo(() => harnessOwnerTitles(threads), [threads]);
  const list = useMemo(
    () => buildHarnessChecksList(checks, query, ownerTitle),
    [checks, ownerTitle, query],
  );
  const showFeeds = feedsExpanded || list.feedsOpen;
  const oldest = snapshots.map((snapshot) => snapshot.generatedAt).sort()[0];
  const freshness = describeHarnessFreshness(oldest ?? null, now);
  const count = (state: HarnessCheckView["state"]) =>
    harnessChecks.filter((check) => check.state === state).length;
  const summary = [
    count("failing") > 0 ? `${count("failing")} failing` : null,
    count("overdue") > 0 ? `${count("overdue")} overdue` : null,
    ...describeHarnessSources(snapshots),
  ].filter((part) => part !== null);
  const openCheck = (check: HarnessCheckView) =>
    navigation.navigate("HarnessCheck", harnessCheckRef(check));
  const renderCheck = (check: HarnessCheckView) => (
    <CheckRow key={check.key} check={check} onOpen={openCheck} />
  );
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
      <Text
        className={cn(
          "border-b border-border px-2 pt-3 pb-2 text-xs text-foreground-muted",
          strip.stale && "opacity-60",
        )}
      >
        {strip.parts.map((part, index) => (
          <Text key={part.label}>
            {index > 0 ? " · " : ""}
            {part.label} <Text className={cn("text-xs", STRIP_TONE[part.tone])}>{part.value}</Text>
          </Text>
        ))}
        {strip.stale ? <Text className="text-xs text-warning-foreground"> · stale</Text> : null}
      </Text>
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
      {snapshots.length > 0 ? (
        <View className="flex-row items-center gap-2 px-2 pb-1">
          <TextInput
            accessibilityLabel="Filter checks"
            autoCapitalize="none"
            autoCorrect={false}
            clearButtonMode="never"
            placeholder="Filter checks"
            returnKeyType="search"
            className="min-h-11 min-w-0 flex-1 rounded-xl py-1.5 text-sm"
            value={query}
            onChangeText={setQuery}
          />
          {query !== "" ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Clear the check filter"
              className="min-h-11 justify-center px-2"
              onPress={() => setQuery("")}
            >
              <Text className="text-sm text-adaptive-sky-600-400">Clear</Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}
      {list.noMatches ? (
        <Text accessibilityRole="alert" className="px-2 py-2 text-xs text-foreground-muted">
          No checks match.
        </Text>
      ) : null}
      {list.checks.map(renderCheck)}
      {list.feeds ? (
        <>
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ expanded: showFeeds }}
            className="min-h-11 justify-center px-2 active:bg-card"
            onPress={() => setFeedsExpanded((value) => !value)}
          >
            <Text className="text-xs text-foreground-muted">
              {showFeeds ? "Hide" : "Show"} {list.feeds.label}
            </Text>
          </Pressable>
          {showFeeds ? list.feeds.checks.map(renderCheck) : null}
        </>
      ) : null}
      {list.unclassified.length > 0 ? (
        <>
          <Text className="px-2 pt-3 pb-1 text-xs font-t3-medium text-foreground-muted">
            UNCLASSIFIED no owner, not Harness
          </Text>
          {list.unclassified.map(renderCheck)}
        </>
      ) : null}
    </ScrollView>
  );
}
