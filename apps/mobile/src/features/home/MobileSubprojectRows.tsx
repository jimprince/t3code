import {
  sortOrchestratorSummariesForSidebar,
  type OrchestratorSummary,
  type OrchestratorThreadShell,
} from "@t3tools/client-runtime/state/orchestrators";
import {
  labelWithTaskProgress,
  projectKeyOf,
  settledGroupSummary,
  splitSettledSubprojects,
  subprojectIsActive,
} from "@t3tools/client-runtime/state/projectSubprojects";
import { useState } from "react";
import { Pressable, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { cn } from "../../lib/cn";
import { relativeTime } from "../../lib/time";
import { MobileDecisionFeed } from "./MobileDecisionFeed";
import { MobileProjectRequests } from "./MobileProjectRequests";
import { MobileTaskFraction } from "./MobileTaskFraction";

/**
 * A project's subprojects as compact "/ Name" rows inside its card, the web sidebar's
 * layout (#156, mock B). A subproject's own requests and decisions render under its row,
 * so nesting it does not hide them; both render nothing when there is none. Settled
 * subprojects are not listed inline: one collapsed "Settled (N)" row ends the list.
 */
export function MobileSubprojectRows({
  summary,
  quietCutoff,
  onSelectThread,
  depth = 0,
}: {
  readonly summary: OrchestratorSummary;
  readonly quietCutoff: number;
  readonly onSelectThread: (thread: OrchestratorThreadShell) => void;
  readonly depth?: number;
}) {
  const [settledOpen, setSettledOpen] = useState(false);
  const { active, settled } = splitSettledSubprojects(
    sortOrchestratorSummariesForSidebar(summary.subprojects, quietCutoff),
  );
  const settledGroup = settledGroupSummary(settled);
  const renderRow = (sub: OrchestratorSummary) => (
    <View key={projectKeyOf(sub)}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={labelWithTaskProgress(`Open ${sub.root.title} subproject`, sub)}
        className="min-h-9 flex-row items-center gap-1.5 pr-1 active:bg-card"
        style={{ paddingLeft: 8 + depth * 12 }}
        onPress={() => onSelectThread(sub.root)}
      >
        <Text className="text-xs text-foreground-muted">/</Text>
        <View
          className={cn(
            "size-1.5 rounded-full",
            sub.rollup.needsYou > 0
              ? "bg-warning-foreground"
              : subprojectIsActive(sub)
                ? "bg-adaptive-sky-600-400"
                : "bg-foreground-muted",
          )}
        />
        <Text className="min-w-0 flex-1 text-xs text-foreground-muted" numberOfLines={1}>
          {sub.root.title}
        </Text>
        {sub.rollup.blocked > 0 ? (
          <Text className="text-xs text-danger-foreground">Blocked</Text>
        ) : null}
        {sub.rollup.needsYou > 0 ? (
          <Text className="text-xs text-warning-foreground">{sub.rollup.needsYou}</Text>
        ) : null}
        <MobileTaskFraction summary={sub} />
        <Text className="text-xs text-foreground-muted">
          {relativeTime(sub.rollup.latestActivityAt)}
        </Text>
      </Pressable>
      <View style={{ paddingLeft: 8 + depth * 12 }}>
        <MobileProjectRequests summary={sub} />
        <MobileDecisionFeed
          summary={sub}
          // Selection reads only the environment and id; a new discussion thread may not
          // be in this list yet.
          onOpenThread={(threadId) => onSelectThread({ ...sub.root, id: threadId })}
        />
      </View>
      <MobileSubprojectRows
        summary={sub}
        quietCutoff={quietCutoff}
        onSelectThread={onSelectThread}
        depth={depth + 1}
      />
    </View>
  );
  return (
    <>
      {active.map(renderRow)}
      {settled.length > 0 ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${settledOpen ? "Hide" : "Show"} ${settledGroup.description}`}
          accessibilityState={{ expanded: settledOpen }}
          className="min-h-9 flex-row items-center justify-between pr-1 active:bg-card"
          style={{ paddingLeft: 8 + depth * 12 }}
          onPress={() => setSettledOpen((open) => !open)}
        >
          <Text
            className={cn(
              "text-xs",
              settledGroup.attention ? "text-warning-foreground" : "text-foreground-muted",
            )}
          >
            {settledGroup.label}
          </Text>
          <Text className="text-xs text-foreground-muted">{settledOpen ? "Hide" : "Show"}</Text>
        </Pressable>
      ) : null}
      {settledOpen ? settled.map(renderRow) : null}
    </>
  );
}
