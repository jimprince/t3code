import { describe, expect, it } from "vitest";

import { EnvironmentId, ThreadId, TurnId } from "@t3tools/contracts";

import { resolveSelectedThreadStopPlan } from "./use-selected-thread-commands";

describe("resolveSelectedThreadStopPlan", () => {
  const environmentId = EnvironmentId.make("env-mobile");
  const threadId = ThreadId.make("thread-mobile");
  const activeTurnId = TurnId.make("turn-active");

  it("interrupts using hydrated thread detail even when the shell snapshot lags behind", () => {
    const plan = resolveSelectedThreadStopPlan({
      selectedThreadShell: {
        environmentId,
        id: threadId,
        session: {
          status: "ready",
          activeTurnId: null,
        },
      },
      selectedThreadDetail: {
        session: {
          status: "running",
          activeTurnId,
        },
      },
      queueCount: 0,
    });

    expect(plan).toEqual({
      environmentId,
      threadId,
      turnId: activeTurnId,
      shouldInterrupt: true,
      shouldClearQueue: false,
    });
  });

  it("clears queued sends even when there is no active session left to interrupt", () => {
    const plan = resolveSelectedThreadStopPlan({
      selectedThreadShell: {
        environmentId,
        id: threadId,
        session: {
          status: "ready",
          activeTurnId: null,
        },
      },
      selectedThreadDetail: {
        session: {
          status: "ready",
          activeTurnId: null,
        },
      },
      queueCount: 2,
    });

    expect(plan).toEqual({
      environmentId,
      threadId,
      shouldInterrupt: false,
      shouldClearQueue: true,
    });
  });

  it("returns null when there is nothing to stop", () => {
    const plan = resolveSelectedThreadStopPlan({
      selectedThreadShell: {
        environmentId,
        id: threadId,
        session: {
          status: "ready",
          activeTurnId: null,
        },
      },
      selectedThreadDetail: {
        session: {
          status: "ready",
          activeTurnId: null,
        },
      },
      queueCount: 0,
    });

    expect(plan).toBeNull();
  });
});
