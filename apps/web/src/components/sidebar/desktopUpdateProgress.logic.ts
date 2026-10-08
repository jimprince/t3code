import type { DesktopUpdatePhase, DesktopUpdateState } from "@t3tools/contracts";

/** Phases of one update, in the order the update card counts them. */
const UPDATE_PHASES = [
  "checking",
  "downloading",
  "verifying",
  "installing",
  "restarting",
] as const satisfies ReadonlyArray<DesktopUpdatePhase>;
export const UPDATE_STEP_COUNT = UPDATE_PHASES.length;

const PHASE_LABEL: Record<DesktopUpdatePhase, string> = {
  checking: "Checking for update",
  downloading: "Downloading",
  verifying: "Verifying download",
  installing: "Installing",
  restarting: "Restarting T3 Code",
};

/** What the update card shows: a step of five, or the step that failed with its reason. */
export type DesktopUpdateProgress =
  | {
      readonly kind: "active";
      readonly title: string;
      readonly step: number;
      readonly label: string;
      readonly detail: string | null;
    }
  | {
      readonly kind: "failed";
      readonly title: string;
      readonly step: number;
      readonly reason: string;
      readonly canRetry: boolean;
    };

/** "fork.5" for a fork build, else the version as published. */
function updateTargetName(state: DesktopUpdateState): string | null {
  const version = state.downloadedVersion ?? state.availableVersion;
  if (!version) return null;
  return version.match(/-fork\.(\d+)$/)?.[0]?.slice(1) ?? version;
}

function formatMegabytes(bytes: number): string {
  return `${Math.round(bytes / (1024 * 1024))}`;
}

/** "42% · 66 of 158 MB"; the sizes are left out until the updater reports a total. */
export function describeDownload(state: DesktopUpdateState): string | null {
  if (state.downloadPercent === null) return null;
  const percent = `${Math.floor(state.downloadPercent)}%`;
  const { downloadTransferredBytes: done, downloadTotalBytes: total } = state;
  return total && total > 0 && done !== undefined
    ? `${percent} · ${formatMegabytes(done)} of ${formatMegabytes(total)} MB`
    : percent;
}

const FAILED_STEP = { check: 1, download: 2, install: 4 } as const;

/**
 * The card for the update this window is running. `running` is true from the click until the
 * update call settles. A background check or a failure nobody started shows nothing here: the
 * pill and its toasts already cover them. Shells without `updatePhase` report only the download.
 */
export function resolveDesktopUpdateProgress(
  state: DesktopUpdateState | null,
  flow: "idle" | "running" | "failed",
): DesktopUpdateProgress | null {
  if (state === null) return null;
  const name = updateTargetName(state);
  const title = `Updating${name ? ` to ${name}` : ""}`;
  if (flow === "failed" && state.status === "error") {
    return {
      kind: "failed",
      title: "Update failed",
      step: state.errorContext === null ? 1 : FAILED_STEP[state.errorContext],
      reason: state.message ?? "The update did not finish.",
      canRetry: state.canRetry,
    };
  }
  const phase = state.updatePhase ?? (state.status === "downloading" ? "downloading" : null);
  if (phase === null || (phase === "checking" && flow !== "running")) return null;
  return {
    kind: "active",
    title,
    step: UPDATE_PHASES.indexOf(phase) + 1,
    label: PHASE_LABEL[phase],
    detail: phase === "downloading" ? describeDownload(state) : null,
  };
}

export function getDesktopUpdateStartConfirmationMessage(
  state: Pick<DesktopUpdateState, "availableVersion" | "downloadedVersion">,
): string {
  const version = state.downloadedVersion ?? state.availableVersion;
  return `Update${version ? ` to ${version}` : ""} and restart T3 Code?\n\nAgents will be interrupted. Make sure you're ready before continuing.`;
}
