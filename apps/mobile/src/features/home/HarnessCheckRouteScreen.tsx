import { useFocusEffect, useNavigation, type StaticScreenProps } from "@react-navigation/native";
import {
  resolveHarnessCheckPage,
  type HarnessCheckPage,
} from "@t3tools/client-runtime/state/harness-check-page";
import type { HarnessTone } from "@t3tools/client-runtime/state/harness-view";
import { useMemo } from "react";
import { Pressable, ScrollView, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { cn } from "../../lib/cn";
import { useHarnessEnvironments, useHarnessNow } from "../../state/harness";

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

function Section({
  title,
  children,
}: {
  readonly title: string;
  readonly children: React.ReactNode;
}) {
  return (
    <View className="gap-1 pt-4">
      <Text className="text-xs font-t3-medium text-foreground-muted">{title}</Text>
      {children}
    </View>
  );
}

function CheckBody({ page }: { readonly page: HarnessCheckPage }) {
  const navigation = useNavigation();
  const { check, facts, runs } = page;
  const openThread = (link: { readonly environmentId: string; readonly threadId: string }) =>
    navigation.navigate("Thread", { environmentId: link.environmentId, threadId: link.threadId });
  return (
    <>
      <View className="gap-1">
        <View className="flex-row items-center gap-2">
          <View className={cn("h-2 w-2 rounded-full", TONE_DOT[check.tone])} />
          <Text className="min-w-0 flex-1 text-lg font-t3-bold text-foreground">{check.name}</Text>
          <Text className={cn("text-sm", TONE_TEXT[check.tone])}>
            {check.latenessLabel ?? check.stateLabel}
          </Text>
        </View>
        <Text className="text-sm text-foreground-muted">
          {[check.classification, page.environmentLabel].filter((part) => part).join(" · ")}
        </Text>
        <Text className="text-sm text-foreground">{check.evidence}</Text>
        {page.readError !== null ? (
          <Text accessibilityRole="alert" className="text-sm text-warning-foreground">
            {`The server did not answer (${page.readError}); showing the last read, ${page.freshness.label}.`}
          </Text>
        ) : null}
        <Text
          className={cn(
            "text-xs",
            page.freshness.stale ? "text-warning-foreground" : "text-foreground-muted",
          )}
        >
          {page.freshness.stale ? `stale, ${page.freshness.label}` : page.freshness.label}
        </Text>
      </View>

      {check.whatItChecks ? (
        <Section title="WHAT IT CHECKS">
          <Text className="text-sm text-foreground">{check.whatItChecks}</Text>
        </Section>
      ) : null}

      <Section title="STATUS">
        {facts.map((fact) => (
          <View key={fact.label} className="flex-row gap-3">
            <Text className="w-32 text-sm text-foreground-muted">{fact.label}</Text>
            <Text className="min-w-0 flex-1 text-sm text-foreground">{fact.value}</Text>
          </View>
        ))}
        {check.owner ? (
          <View className="min-h-11 flex-row items-center gap-3">
            <Text className="w-32 text-sm text-foreground-muted">Owner thread</Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Open the owner thread of ${check.name}`}
              className="min-h-11 justify-center"
              onPress={() => check.owner && openThread(check.owner)}
            >
              <Text className="text-sm text-adaptive-sky-600-400">Open</Text>
            </Pressable>
          </View>
        ) : null}
      </Section>

      <Section title="RUNS">
        {runs.length === 0 ? (
          <Text className="text-sm text-foreground-muted">No runs retained.</Text>
        ) : null}
        {runs.map((run) => (
          <View
            key={run.key}
            className="min-h-11 flex-row items-center gap-2 border-b border-border"
          >
            <Text className="w-24 text-sm text-foreground-muted">{run.timeLabel}</Text>
            <View className="min-w-0 flex-1 py-1">
              <Text
                className={cn("text-sm", run.failed ? "text-destructive" : "text-foreground")}
                numberOfLines={1}
              >
                {run.outcomeLabel}
              </Text>
              {run.outcomeLabel === "Completed" ? null : (
                <Text className="text-xs text-foreground-muted">{run.evidence}</Text>
              )}
            </View>
            <Text className="text-sm text-foreground-muted">{run.errorsLabel}</Text>
            {run.thread ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Open run of ${check.name} at ${run.timeLabel}`}
                className="min-h-11 justify-center px-2"
                onPress={() => run.thread && openThread(run.thread)}
              >
                <Text className="text-sm text-adaptive-sky-600-400">Open</Text>
              </Pressable>
            ) : (
              <Text className="w-12 text-right text-sm text-foreground-muted">none</Text>
            )}
          </View>
        ))}
        {page.historyNote ? (
          <Text className="text-xs text-foreground-muted">{page.historyNote}</Text>
        ) : null}
      </Section>
    </>
  );
}

/**
 * One Harness check on the phone, pushed from its row in the Harness list: the same page the web
 * main pane shows, built by the same client-runtime resolver, with the run history below. Read
 * again whenever the screen regains focus; the query's own interval covers the time between.
 */
export function HarnessCheckRouteScreen({
  route,
}: StaticScreenProps<{ readonly environmentId: string; readonly checkKey: string }>) {
  const navigation = useNavigation();
  const { environmentId, checkKey } = route.params;
  const { environments, refresh } = useHarnessEnvironments();
  useFocusEffect(refresh);
  const now = useHarnessNow();
  const state = useMemo(
    () => resolveHarnessCheckPage(environments, { environmentId, checkKey }, now),
    [checkKey, environmentId, environments, now],
  );
  return (
    <ScrollView className="flex-1" contentContainerClassName="px-4 pb-24 pt-2">
      {state.kind === "found" ? (
        <CheckBody page={state.page} />
      ) : state.kind === "not-found" ? (
        <View className="items-start gap-3 pt-4">
          <Text className="text-sm text-foreground-muted">{state.message}</Text>
          <Pressable
            accessibilityRole="button"
            className="min-h-11 justify-center"
            onPress={() => navigation.goBack()}
          >
            <Text className="text-sm text-adaptive-sky-600-400">Back to Harness</Text>
          </Pressable>
        </View>
      ) : state.kind === "error" ? (
        <View className="items-start gap-3 pt-4">
          <Text accessibilityRole="alert" className="text-sm text-destructive">
            {state.message}
          </Text>
          <Pressable
            accessibilityRole="button"
            className="min-h-11 justify-center"
            onPress={refresh}
          >
            <Text className="text-sm text-adaptive-sky-600-400">Retry</Text>
          </Pressable>
        </View>
      ) : (
        <Text accessibilityRole="progressbar" className="pt-4 text-sm text-foreground-muted">
          Loading the check...
        </Text>
      )}
    </ScrollView>
  );
}
