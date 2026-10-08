import type { OrchestratorThreadShell } from "@t3tools/client-runtime/state/orchestrators";
import { ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { taskStepProgress } from "./taskProgress.logic";

const thread = (
  running: boolean,
  todoProgress: { completed: number; total: number } | null,
): OrchestratorThreadShell =>
  ({
    runtime: { status: running ? "running" : "idle" },
    pendingBackgroundTasks: [],
    codexNativeGoal: null,
    todoProgress,
  }) as unknown as OrchestratorThreadShell;

describe("taskStepProgress", () => {
  const issue = { linkedThreadIds: [ThreadId.make("a"), ThreadId.make("b")] };

  it("reports the working linked thread's steps", () => {
    const threads = new Map([["a", thread(true, { completed: 3, total: 5 })]]);
    expect(taskStepProgress(issue, threads)).toBe("3 of 5 steps");
  });

  it("ignores a thread that is no longer working", () => {
    const threads = new Map([["a", thread(false, { completed: 5, total: 5 })]]);
    expect(taskStepProgress(issue, threads)).toBeNull();
  });

  it("shows nothing without a to-do list", () => {
    const threads = new Map([
      ["a", thread(true, null)],
      ["b", thread(true, { completed: 0, total: 0 })],
    ]);
    expect(taskStepProgress(issue, threads)).toBeNull();
  });

  it("prefers the thread with the most work left when several are working", () => {
    const threads = new Map([
      ["a", thread(true, { completed: 4, total: 5 })],
      ["b", thread(true, { completed: 1, total: 6 })],
    ]);
    expect(taskStepProgress(issue, threads)).toBe("1 of 6 steps");
  });
});
