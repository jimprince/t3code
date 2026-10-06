import {
  EnvironmentId,
  ProjectId,
  ThreadId,
  RunId,
  ProviderInstanceId,
  DEFAULT_SERVER_SETTINGS,
  type ServerConfig,
} from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";
import {
  countAgentsBlockingIdleRestart,
  makeResumesMonitoring,
  idleRestartTooltip,
  isThreadBlockingIdleRestart,
} from "./desktopIdleRestart.logic";
type Thread = Parameters<typeof isThreadBlockingIdleRestart>[0];
const LOCAL = EnvironmentId.make("local-env");
const REMOTE = EnvironmentId.make("remote-env");
function thread(status = "idle", overrides: Partial<Thread> = {}): Thread {
  return {
    environmentId: LOCAL,
    projectId: ProjectId.make("project"),
    id: ThreadId.make("thread"),
    runtime: {
      status,
      activeRunId: status === "idle" ? null : RunId.make("run"),
      providerInstanceId: ProviderInstanceId.make("codex"),
      providerName: "Codex",
      updatedAt: "2026-10-05T00:00:00Z",
      lastError: null,
    } as Thread["runtime"],
    latestRun: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    pendingBackgroundTasks: [],
    ...overrides,
  };
}
it.each(["preparing", "queued", "starting", "running", "waiting"])(
  "blocks %s native work",
  (status) => {
    expect(isThreadBlockingIdleRestart(thread(status))).toBe(true);
  },
);
it("allows idle threads and user-input waits", () => {
  expect(isThreadBlockingIdleRestart(thread())).toBe(false);
  expect(isThreadBlockingIdleRestart(thread("waiting", { hasPendingUserInput: true }))).toBe(false);
  expect(isThreadBlockingIdleRestart(thread("waiting", { hasPendingApprovals: true }))).toBe(false);
});
it("keeps server-owned queued runs blocking during the runtime gap", () => {
  expect(
    isThreadBlockingIdleRestart(
      thread("idle", {
        latestRun: {
          runId: RunId.make("queued"),
          status: "queued",
          requestedAt: "2026-10-05T00:00:00Z",
          startedAt: null,
          completedAt: null,
          assistantMessageId: null,
        },
      }),
    ),
  ).toBe(true);
});
it("counts only desktop-hosted agents and includes background work", () => {
  expect(
    countAgentsBlockingIdleRestart({
      threads: [
        thread("running"),
        thread("running", { environmentId: REMOTE }),
        thread("idle", { pendingBackgroundTasks: [{ taskId: "devserver", kind: "command" }] }),
      ],
      localEnvironmentIds: new Set([LOCAL]),
    }),
  ).toBe(2);
});
it("renders singular and plural restart intent", () => {
  expect(idleRestartTooltip(1)).toContain("when 1 agent finishes");
  expect(idleRestartTooltip(3)).toContain("when 3 agents finish");
});

it("allows only opted-in, rearmable monitor-only threads while preserving agents and commands", () => {
  const config = {
    environment: { capabilities: { backgroundWorkResume: true } },
    settings: { ...DEFAULT_SERVER_SETTINGS, continueThreadsAfterServerUpdate: true },
  } as Pick<ServerConfig, "environment" | "settings">;
  const resumes = makeResumesMonitoring([{ environmentId: LOCAL, serverConfig: config }]);
  const monitor = thread("idle", {
    pendingBackgroundTasks: [{ taskId: "watch", kind: "monitor" }],
  });
  expect(isThreadBlockingIdleRestart(monitor, resumes(monitor))).toBe(false);
  expect(isThreadBlockingIdleRestart(monitor, false)).toBe(true);
  expect(
    isThreadBlockingIdleRestart({ ...monitor, runtime: thread("running").runtime }, true),
  ).toBe(true);
  expect(
    isThreadBlockingIdleRestart(
      thread("idle", { pendingBackgroundTasks: [{ taskId: "agent", kind: "subagent" }] }),
      true,
    ),
  ).toBe(true);
  expect(
    isThreadBlockingIdleRestart(
      thread("idle", { pendingBackgroundTasks: [{ taskId: "command", kind: "command" }] }),
      true,
    ),
  ).toBe(true);
  expect(makeResumesMonitoring([{ environmentId: REMOTE, serverConfig: config }])(monitor)).toBe(
    false,
  );
  expect(
    makeResumesMonitoring([
      {
        environmentId: LOCAL,
        serverConfig: {
          ...config,
          settings: { ...config.settings, continueThreadsAfterServerUpdate: false },
        },
      },
    ])(monitor),
  ).toBe(false);
});
