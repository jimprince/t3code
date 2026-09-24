import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  countAgentsBlockingIdleRestart,
  idleRestartTooltip,
  isThreadBlockingIdleRestart,
} from "./desktopIdleRestart.logic";

type Thread = Parameters<typeof isThreadBlockingIdleRestart>[0];

const LOCAL = EnvironmentId.make("local-env");
const REMOTE = EnvironmentId.make("remote-env");

function thread(id: string, overrides: Partial<Thread> & { status?: string } = {}): Thread {
  const { status, ...rest } = overrides;
  return {
    environmentId: LOCAL,
    id: ThreadId.make(id),
    session: status ? ({ status } as unknown as Thread["session"]) : null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    backgroundLiveness: null,
    ...rest,
  };
}

const queued = { holdUntilUserAction: false };
const held = { holdUntilUserAction: true };

describe("isThreadBlockingIdleRestart", () => {
  it("waits for a running or starting turn", () => {
    expect(isThreadBlockingIdleRestart(thread("a", { status: "running" }), [])).toBe(true);
    expect(isThreadBlockingIdleRestart(thread("a", { status: "starting" }), [])).toBe(true);
    expect(isThreadBlockingIdleRestart(thread("a", { status: "ready" }), [])).toBe(false);
    expect(isThreadBlockingIdleRestart(thread("a"), [])).toBe(false);
  });

  it("does not wait on an agent paused for an approval or an answer", () => {
    const approval = thread("a", { status: "running", hasPendingApprovals: true });
    const question = thread("b", { status: "running", hasPendingUserInput: true });
    expect(isThreadBlockingIdleRestart(approval, [queued])).toBe(false);
    expect(isThreadBlockingIdleRestart(question, [])).toBe(false);
  });

  it("waits for background work and monitoring loops", () => {
    expect(isThreadBlockingIdleRestart(thread("a", { backgroundLiveness: "working" }), [])).toBe(
      true,
    );
    expect(
      isThreadBlockingIdleRestart(
        thread("a", { backgroundLiveness: "monitoring", hasPendingUserInput: true }),
        [],
      ),
    ).toBe(true);
  });

  it("waits for queued messages, which a restart would lose, but not held ones", () => {
    expect(isThreadBlockingIdleRestart(thread("a", { status: "ready" }), [queued])).toBe(true);
    expect(isThreadBlockingIdleRestart(thread("a", { status: "ready" }), [held])).toBe(false);
  });
});

describe("countAgentsBlockingIdleRestart", () => {
  it("counts only agents hosted by this desktop app", () => {
    const localRunning = thread("local", { status: "running" });
    const remoteRunning = thread("remote", { environmentId: REMOTE, status: "running" });
    const localQueued = thread("queued", { status: "ready" });

    const count = countAgentsBlockingIdleRestart({
      threads: [localRunning, remoteRunning, localQueued],
      localEnvironmentIds: new Set([LOCAL]),
      queuesByThreadKey: {
        [scopedThreadKey(scopeThreadRef(LOCAL, localQueued.id))]: [queued],
        [scopedThreadKey(scopeThreadRef(REMOTE, remoteRunning.id))]: [queued],
      },
    });

    expect(count).toBe(2);
  });
});

describe("idleRestartTooltip", () => {
  it("says how many agents the restart is waiting for", () => {
    expect(idleRestartTooltip(1)).toContain("when 1 agent finishes");
    expect(idleRestartTooltip(3)).toContain("when 3 agents finish");
    expect(idleRestartTooltip(0)).toContain("once agents stay idle");
  });
});
