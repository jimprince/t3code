import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildThreadMoveFailureReport,
  collectErrorDiagnostics,
  describeThreadMoveOutcome,
  describeThreadMoveProgress,
  isThreadMoveBranchConflict,
  moveThreadWithBranchFallback,
  type ThreadMoveResult,
} from "./threadMove";

describe("collectErrorDiagnostics", () => {
  it("flattens tagged errors with nested causes into ordered lines", () => {
    const error = {
      _tag: "OrchestrationImportThreadError",
      message: "Failed to record the imported thread.",
      cause: {
        _tag: "SqlError",
        message: "Failed to execute statement",
        cause: new Error("SQLITE_TOOBIG: string or blob too big"),
      },
    };
    const lines = collectErrorDiagnostics(error);
    expect(lines[0]).toContain("OrchestrationImportThreadError");
    expect(lines[0]).toContain("Failed to record the imported thread.");
    // REGRESSION: the underlying SQL detail must survive — the toast used to
    // show only the useless top-level "Failed to execute statement".
    expect(lines.join("\n")).toContain("SqlError");
    expect(lines.join("\n")).toContain("SQLITE_TOOBIG");
  });

  it("includes branch-conflict reasons and tolerates plain values", () => {
    expect(
      collectErrorDiagnostics({
        _tag: "OrchestrationImportThreadError",
        reason: "branch-conflict",
        message: "nope",
      }).join("\n"),
    ).toContain("reason=branch-conflict");
    expect(collectErrorDiagnostics("plain failure")).toEqual(["plain failure"]);
    expect(collectErrorDiagnostics(undefined)).toEqual(["An unknown error occurred."]);
  });
});

describe("buildThreadMoveFailureReport", () => {
  it("captures thread, route, phase, and the error chain", () => {
    const report = buildThreadMoveFailureReport({
      error: {
        _tag: "OrchestrationImportThreadError",
        message: "Failed to record the imported thread.",
        cause: { _tag: "SqlError", message: "Failed to execute statement" },
      },
      threadTitle: "My thread",
      source: {
        environmentId: EnvironmentId.make("env-source"),
        threadId: ThreadId.make("thread-1"),
      },
      sourceLabel: "local-mbp",
      target: {
        environmentId: EnvironmentId.make("env-target"),
        projectId: ProjectId.make("project-target"),
      },
      targetLabel: "dev-vm",
      phase: "importing",
    });
    expect(report).toContain('Thread: "My thread" (thread-1)');
    expect(report).toContain("From: local-mbp (env env-source)");
    expect(report).toContain("To: dev-vm (env env-target, project project-target)");
    expect(report).toContain("Failed while: importing");
    expect(report).toContain("Error chain:");
    expect(report).toContain("SqlError: Failed to execute statement");
  });
});
const moved: ThreadMoveResult = {
  threadId: ThreadId.make("thread-2"),
  worktreePath: null,
  warnings: [],
  sourceArchived: true,
};
const conflict = { _tag: "ThreadTransferError", reason: "branch-conflict" };

describe("isThreadMoveBranchConflict", () => {
  it("finds the reason anywhere in the cause chain", () => {
    expect(isThreadMoveBranchConflict(conflict)).toBe(true);
    expect(isThreadMoveBranchConflict({ _tag: "RpcError", cause: conflict })).toBe(true);
    expect(isThreadMoveBranchConflict({ reason: "other" })).toBe(false);
    expect(isThreadMoveBranchConflict("branch-conflict")).toBe(false);
  });
});

describe("moveThreadWithBranchFallback", () => {
  it("does not ask when the first attempt succeeds", async () => {
    const modes: string[] = [];
    const result = await moveThreadWithBranchFallback({
      run: async (mode) => {
        modes.push(mode);
        return moved;
      },
      branch: "main",
      confirmBranchFallback: async () => {
        throw new Error("must not ask");
      },
    });
    expect(result).toBe(moved);
    expect(modes).toEqual(["fail"]);
  });

  it("retries on a fallback branch once the user agrees", async () => {
    const modes: string[] = [];
    const asked: string[] = [];
    const result = await moveThreadWithBranchFallback({
      run: async (mode) => {
        modes.push(mode);
        if (mode === "fail") throw conflict;
        return moved;
      },
      branch: "main",
      confirmBranchFallback: async (branch) => {
        asked.push(branch);
        return true;
      },
    });
    expect(result).toBe(moved);
    expect(modes).toEqual(["fail", "new-worktree"]);
    expect(asked).toEqual(["main"]);
  });

  it("rethrows the conflict when the user declines", async () => {
    await expect(
      moveThreadWithBranchFallback({
        run: async () => {
          throw conflict;
        },
        branch: "main",
        confirmBranchFallback: async () => false,
      }),
    ).rejects.toBe(conflict);
  });

  it("rethrows other failures without asking", async () => {
    const failure = new Error("offline");
    await expect(
      moveThreadWithBranchFallback({
        run: async () => {
          throw failure;
        },
        branch: "main",
        confirmBranchFallback: async () => {
          throw new Error("must not ask");
        },
      }),
    ).rejects.toBe(failure);
  });
});

describe("move toasts", () => {
  it("names each phase", () => {
    expect(describeThreadMoveProgress("exporting", "dev-vm").description).toBe(
      "Exporting from the source machine",
    );
    expect(describeThreadMoveProgress("importing", "dev-vm").description).toBe(
      "Importing on dev-vm",
    );
  });

  it("confirms a clean move", () => {
    expect(
      describeThreadMoveOutcome({ threadTitle: "T", targetLabel: "dev-vm", result: moved }),
    ).toEqual({ type: "success", description: '"T" now runs on dev-vm.', timeout: 8000 });
  });

  it("keeps warnings and a failed archive on screen", () => {
    expect(
      describeThreadMoveOutcome({
        threadTitle: "T",
        targetLabel: "dev-vm",
        result: { ...moved, warnings: ["Skipped 1 file."], sourceArchived: false },
      }),
    ).toEqual({
      type: "warning",
      description: "Skipped 1 file.\nThe source copy could not be archived; archive it manually.",
      timeout: 0,
    });
  });
});
