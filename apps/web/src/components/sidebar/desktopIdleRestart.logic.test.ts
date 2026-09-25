import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ProjectId,
  type ServerConfig,
  ThreadId,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  countAgentsBlockingIdleRestart,
  idleRestartTooltip,
  isThreadBlockingIdleRestart,
  makeResumesMonitoring,
} from "./desktopIdleRestart.logic";

type Thread = Parameters<typeof isThreadBlockingIdleRestart>[0];

const LOCAL = EnvironmentId.make("local-env");
const REMOTE = EnvironmentId.make("remote-env");

function thread(id: string, overrides: Partial<Thread> & { status?: string } = {}): Thread {
  const { status, ...rest } = overrides;
  return {
    environmentId: LOCAL,
    id: ThreadId.make(id),
    projectId: ProjectId.make("project"),
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

  it("does not wait on monitors the server resumes after the restart", () => {
    const monitoring = thread("a", { backgroundLiveness: "monitoring" });
    expect(isThreadBlockingIdleRestart(monitoring, [], true)).toBe(false);
    // Background agents would restart from scratch, and a live turn is live.
    expect(
      isThreadBlockingIdleRestart(thread("b", { backgroundLiveness: "working" }), [], true),
    ).toBe(true);
    expect(
      isThreadBlockingIdleRestart(
        thread("c", { backgroundLiveness: "monitoring", status: "running" }),
        [],
        true,
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

describe("makeResumesMonitoring", () => {
  const config = (
    backgroundWorkResume: boolean,
    settings: Partial<typeof DEFAULT_SERVER_SETTINGS>,
  ): Pick<ServerConfig, "environment" | "settings"> =>
    ({
      environment: { capabilities: backgroundWorkResume ? { backgroundWorkResume } : {} },
      settings: { ...DEFAULT_SERVER_SETTINGS, ...settings },
    }) as Pick<ServerConfig, "environment" | "settings">;

  it("resumes monitors only where the server supports it and continuation is on", () => {
    const resumes = makeResumesMonitoring([
      {
        environmentId: LOCAL,
        serverConfig: config(true, { continueThreadsAfterServerUpdate: true }),
      },
      {
        environmentId: REMOTE,
        serverConfig: config(false, { continueThreadsAfterServerUpdate: true }),
      },
    ]);
    expect(resumes(thread("a"))).toBe(true);
    expect(resumes(thread("b", { environmentId: REMOTE }))).toBe(false);
    expect(makeResumesMonitoring([{ environmentId: LOCAL, serverConfig: null }])(thread("c"))).toBe(
      false,
    );
    expect(
      makeResumesMonitoring([
        {
          environmentId: LOCAL,
          serverConfig: config(true, { continueThreadsAfterServerUpdate: false }),
        },
      ])(thread("d")),
    ).toBe(false);
  });

  it("honors a project that turns continuation off", () => {
    const resumes = makeResumesMonitoring([
      {
        environmentId: LOCAL,
        serverConfig: config(true, {
          continueThreadsAfterServerUpdate: true,
          projectSettingsOverrides: {
            [ProjectId.make("quiet")]: { continueThreadsAfterServerUpdate: false },
          },
        }),
      },
    ]);
    expect(resumes(thread("a"))).toBe(true);
    expect(resumes(thread("b", { projectId: ProjectId.make("quiet") }))).toBe(false);
  });
});
