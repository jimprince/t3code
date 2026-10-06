import { useSupervisionForest } from "../../state/forkSupervision";
import { useNavigate } from "@tanstack/react-router";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import {
  supervisionThreadKey,
} from "@t3tools/client-runtime/state/fork-nesting";
import { useServerConfigs, useProjects } from "../../state/entities";
import { buildThreadRouteParams } from "../../threadRoutes";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { ThreadDetailsSection } from "./ThreadDetailsSection";

import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";

/** Organizational workers are distinct from native fork/subagent Lineage. */
export function SupervisionRows(props: { environmentId: EnvironmentId; threadId: ThreadId }) {
  const forest = useSupervisionForest();
  const children = (forest.children.get(`${props.environmentId}:${props.threadId}`) ?? []).toSorted(
    (a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
  );
  if (children.length === 0) return null;
  return (
    <ThreadDetailsSection headingId="supervision-heading" title="Supervision">
      {children.map((child) => (
        <SupervisionWorkerRow key={supervisionThreadKey(child)} child={child} />
      ))}
    </ThreadDetailsSection>
  );
}

/** The nesting controls can reuse this row without another worker roster. */
export function SupervisionWorkerRow({ child }: { child: EnvironmentThreadShell }) {
  const configs = useServerConfigs();
  const projects = useProjects();
  const navigate = useNavigate();
  const summary = child.source.workerSummary;
  const providerId = child.runtime?.providerInstanceId ?? child.providerInstanceId;
  const provider = configs
    .get(child.environmentId)
    ?.providers.find((p) => p.instanceId === providerId);
  const project = projects.find(
    (p) => p.environmentId === child.environmentId && p.id === child.projectId,
  );
  const run = child.latestRun;
  const duration =
    run?.startedAt && run.completedAt
      ? Math.max(0, Date.parse(run.completedAt) - Date.parse(run.startedAt))
      : null;
  return (
    <button
      type="button"
      key={supervisionThreadKey(child)}
      className="flex w-full flex-col gap-1 px-2 py-1 text-left text-xs"
      onClick={() => {
        void navigate({
          to: "/$environmentId/$threadId",
          params: buildThreadRouteParams(scopeThreadRef(child.environmentId, child.id)),
        });
      }}
    >
      <span>
        {child.title} ·{" "}
        {child.settledOverride === "settled"
          ? "Settled"
          : child.hasPendingApprovals
            ? "Needs approval"
            : child.hasPendingUserInput
              ? "Needs input"
              : child.hasActionableProposedPlan
                ? "Plan ready"
                : (child.runtime?.status ?? child.latestRun?.status ?? "idle")}
      </span>
      <span>
        {provider?.displayName ?? providerId} · {child.modelSelection.model}
      </span>
      {summary?.output ? <span>{summary.output}</span> : null}
      <span>
        {summary
          ? `${summary.messageCount} messages · ${summary.toolCount} tools`
          : "Summary unavailable"}
        {summary?.usedTokens == null ? "" : ` · ${summary.usedTokens} tokens`}
        {duration === null ? "" : ` · ${Math.round(duration / 1000)}s`}
      </span>
      {summary?.activity ? <span>{summary.activity}</span> : null}
      {summary?.history === "legacy-unavailable" ? (
        <span>Imported V1 activity and usage unavailable</span>
      ) : null}
      <span>
        {child.worktreePath ?? project?.workspaceRoot ?? child.branch ?? "Project workspace"}
      </span>
    </button>
  );
}
