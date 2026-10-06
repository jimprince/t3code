import type { EnvironmentId, ProjectId, ServerSettings } from "@t3tools/contracts";

export type AutoSettleSettings = Pick<
  ServerSettings,
  | "sidebarAutoSettleAfterDays"
  | "sidebarAutoSettleOnMerge"
  | "subthreadSettleOnComplete"
  | "settledSubthreadArchiveAfterDays"
>;

interface AutoSettleSyncTarget {
  readonly environmentId: EnvironmentId;
  readonly projectId?: ProjectId | null;
  readonly label: string;
  readonly settings: AutoSettleSettings | null;
}

/** Receives connected, capable targets. Applying these defaults must preserve other settings. */
export function planAutoSettleSettingsSync(
  reference: {
    readonly environmentId: EnvironmentId;
    readonly projectId?: ProjectId | null;
    readonly settings: AutoSettleSettings;
  },
  targets: readonly AutoSettleSyncTarget[],
) {
  const patch: AutoSettleSettings = {
    subthreadSettleOnComplete: reference.settings.subthreadSettleOnComplete,
    settledSubthreadArchiveAfterDays: reference.settings.settledSubthreadArchiveAfterDays,
    sidebarAutoSettleAfterDays: reference.settings.sidebarAutoSettleAfterDays,
    sidebarAutoSettleOnMerge: reference.settings.sidebarAutoSettleOnMerge,
  };
  const mismatches = targets.filter(
    (target) =>
      (target.environmentId !== reference.environmentId ||
        target.projectId !== reference.projectId) &&
      target.settings !== null &&
      (target.settings.subthreadSettleOnComplete !== patch.subthreadSettleOnComplete ||
        target.settings.settledSubthreadArchiveAfterDays !==
          patch.settledSubthreadArchiveAfterDays ||
        target.settings.sidebarAutoSettleAfterDays !== patch.sidebarAutoSettleAfterDays ||
        target.settings.sidebarAutoSettleOnMerge !== patch.sidebarAutoSettleOnMerge),
  );
  return { patch, mismatches };
}
