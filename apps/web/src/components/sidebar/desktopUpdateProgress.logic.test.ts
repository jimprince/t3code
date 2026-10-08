import type { DesktopUpdateState } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  describeDownload,
  getDesktopUpdateStartConfirmationMessage,
  resolveDesktopUpdateProgress,
} from "./desktopUpdateProgress.logic";

const state = (change: Partial<DesktopUpdateState> = {}): DesktopUpdateState =>
  ({
    enabled: true,
    status: "available",
    availableVersion: "0.0.46-nightly.20261008.1-fork.6",
    downloadedVersion: null,
    downloadPercent: null,
    message: null,
    errorContext: null,
    canRetry: false,
    ...change,
  }) as DesktopUpdateState;

describe("desktop update progress", () => {
  it("counts the five phases of an update this window started", () => {
    expect(
      resolveDesktopUpdateProgress(
        state({ status: "checking", updatePhase: "checking" }),
        "running",
      ),
    ).toMatchObject({
      kind: "active",
      title: "Updating to fork.6",
      step: 1,
      label: "Checking for update",
    });
    expect(
      resolveDesktopUpdateProgress(
        state({ status: "downloaded", updatePhase: "restarting" }),
        "running",
      ),
    ).toMatchObject({ step: 5, label: "Restarting T3 Code" });
  });

  it("stays out of the way of background checks and idle updates", () => {
    const checking = state({ status: "checking", updatePhase: "checking" });
    expect(resolveDesktopUpdateProgress(checking, "idle")).toBeNull();
    expect(resolveDesktopUpdateProgress(state(), "idle")).toBeNull();
    expect(resolveDesktopUpdateProgress(null, "running")).toBeNull();
  });

  it("shows a download from a shell that reports no phase, with sizes once known", () => {
    const downloading = state({
      status: "downloading",
      downloadPercent: 42.4,
      downloadTransferredBytes: 66 * 1024 * 1024,
      downloadTotalBytes: 158 * 1024 * 1024,
    });
    expect(resolveDesktopUpdateProgress(downloading, "idle")).toMatchObject({
      step: 2,
      detail: "42% · 66 of 158 MB",
    });
    expect(describeDownload(state({ downloadPercent: 7, downloadTotalBytes: 0 }))).toBe("7%");
  });

  it("reports the failed step with its reason once the call that started it has settled", () => {
    const failed = state({
      status: "error",
      errorContext: "install",
      message: "Could not replace the app.",
      canRetry: true,
    });
    expect(resolveDesktopUpdateProgress(failed, "failed")).toEqual({
      kind: "failed",
      title: "Update failed",
      step: 4,
      reason: "Could not replace the app.",
      canRetry: true,
    });
    expect(resolveDesktopUpdateProgress(failed, "idle")).toBeNull();
  });

  it("warns that agents will be interrupted", () => {
    expect(getDesktopUpdateStartConfirmationMessage(state())).toContain(
      "Agents will be interrupted",
    );
  });
});
