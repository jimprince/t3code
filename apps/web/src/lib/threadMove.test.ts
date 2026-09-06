import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { buildThreadMoveFailureReport, collectErrorDiagnostics } from "./threadMove";

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
