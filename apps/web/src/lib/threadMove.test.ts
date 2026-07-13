import {
  EnvironmentId,
  ProjectId,
  ThreadId,
  type OrchestrationExportThreadResult,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildThreadMoveFailureReport,
  collectErrorDiagnostics,
  moveThreadToEnvironment,
} from "./threadMove";

const source = {
  environmentId: EnvironmentId.make("env-source"),
  threadId: ThreadId.make("thread-1"),
};
const target = {
  environmentId: EnvironmentId.make("env-target"),
  projectId: ProjectId.make("project-target"),
};
const exported = {
  bundle: { git: null },
} as OrchestrationExportThreadResult;

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

describe("moveThreadToEnvironment", () => {
  it("does not archive the source when target import fails", async () => {
    let archiveCalls = 0;
    await expect(
      moveThreadToEnvironment({
        source,
        target,
        exportThread: async () => exported,
        importThread: async () => {
          throw new Error("target rejected import");
        },
        archiveSource: async () => {
          archiveCalls += 1;
          return { _tag: "Success" };
        },
      }),
    ).rejects.toThrow("target rejected import");
    expect(archiveCalls).toBe(0);
  });

  it("archives exactly once after import and reports data-channel failure", async () => {
    let archiveCalls = 0;
    const result = await moveThreadToEnvironment({
      source,
      target,
      exportThread: async () => exported,
      importThread: async () => ({
        threadId: source.threadId,
        worktreePath: "/target/worktree",
        warnings: [],
      }),
      archiveSource: async () => {
        archiveCalls += 1;
        return { _tag: "Failure" };
      },
    });

    expect(archiveCalls).toBe(1);
    expect(result.warnings).toContain(
      "The source copy could not be archived; archive it manually.",
    );
  });

  it("retries a branch conflict only after explicit fallback confirmation", async () => {
    const importInputs: unknown[] = [];
    const bundleWithBranch = {
      bundle: { ...exported.bundle, git: { branch: "main" } },
    } as OrchestrationExportThreadResult;
    const result = await moveThreadToEnvironment({
      source,
      target,
      exportThread: async () => bundleWithBranch,
      importThread: async (input) => {
        importInputs.push(input);
        if (importInputs.length === 1) {
          throw { reason: "branch-conflict" };
        }
        return { threadId: source.threadId, worktreePath: "/target/worktree", warnings: [] };
      },
      confirmBranchFallback: async () => true,
    });

    expect(result.threadId).toBe(source.threadId);
    expect(importInputs).toHaveLength(2);
    expect(importInputs[1]).toMatchObject({ branchConflict: "new-worktree" });
  });
});
