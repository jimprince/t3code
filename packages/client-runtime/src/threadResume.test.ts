import { EnvironmentId, type OrchestrationV2ThreadShell } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { v2ThreadShell } from "./state/orchestrationV2TestFixtures.ts";
import { presentThreadShell } from "./state/models.ts";
import { isThreadResumable, withFilePlan } from "./threadResume.ts";

const failed = {
  latestRunStatus: "failed",
  hasLiveSession: false,
  hasLiveTurn: false,
  failedSession: true,
} as const;
const present = (overrides: Partial<OrchestrationV2ThreadShell>) =>
  presentThreadShell(EnvironmentId.make("env"), { ...v2ThreadShell, ...overrides });

describe("resume eligibility on a presented shell", () => {
  it("keeps the server's plan resume state so a stopped thread is resumable", () => {
    const shell = present({
      todoProgress: { completed: 1, total: 3 },
      planResumeState: failed,
    });
    expect(shell.planResumeState).toEqual(failed);
    expect(isThreadResumable(shell)).toBe(true);
  });

  it("is not resumable from an older server that sends no state", () => {
    const shell = present({ todoProgress: { completed: 1, total: 3 } });
    expect(shell.planResumeState).toBeUndefined();
    expect(isThreadResumable(shell)).toBe(false);
  });

  it("is not resumable while live, without a plan, or with the plan finished", () => {
    const todo = { completed: 1, total: 3 };
    expect(
      isThreadResumable(
        present({ todoProgress: todo, planResumeState: { ...failed, hasLiveTurn: true } }),
      ),
    ).toBe(false);
    expect(isThreadResumable(present({ planResumeState: failed }))).toBe(false);
    expect(
      isThreadResumable(
        present({ todoProgress: { completed: 3, total: 3 }, planResumeState: failed }),
      ),
    ).toBe(false);
  });
});

describe("file plan overlay", () => {
  const filePlan = (done: number) => ({
    planPath: "/plans/a/PLAN.md",
    host: "dev-vm",
    planTitle: "A",
    status: "in progress",
    done,
    total: 5,
    currentStep: null,
    hasResumePoint: true,
  });

  it("lets steps left in the file plan override a complete native list", () => {
    const shell = present({ todoProgress: { completed: 3, total: 3 }, planResumeState: failed });
    expect(isThreadResumable(shell)).toBe(false);
    expect(isThreadResumable(withFilePlan(shell, filePlan(2)))).toBe(true);
  });

  it("lets a complete file plan override native steps left", () => {
    const shell = present({ todoProgress: { completed: 1, total: 3 }, planResumeState: failed });
    expect(isThreadResumable(shell)).toBe(true);
    expect(isThreadResumable(withFilePlan(shell, filePlan(5)))).toBe(false);
  });

  it("falls back to native progress when no file plan maps", () => {
    const shell = present({ todoProgress: { completed: 1, total: 3 }, planResumeState: failed });
    expect(withFilePlan(shell, undefined)).toBe(shell);
  });
});
