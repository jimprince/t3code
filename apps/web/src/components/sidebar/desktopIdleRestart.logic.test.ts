import { EnvironmentId, ThreadId, RunId, ProviderInstanceId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { countAgentsBlockingIdleRestart, idleRestartTooltip, isThreadBlockingIdleRestart } from "./desktopIdleRestart.logic";
type Thread = Parameters<typeof isThreadBlockingIdleRestart>[0];
const LOCAL = EnvironmentId.make("local-env");
const REMOTE = EnvironmentId.make("remote-env");
function thread(status = "idle", overrides: Partial<Thread> = {}): Thread {
  return { environmentId: LOCAL, id: ThreadId.make("thread"), runtime: { status, activeRunId: status === "idle" ? null : RunId.make("run"),
    providerInstanceId: ProviderInstanceId.make("codex"), providerName: "Codex", updatedAt: "2026-10-05T00:00:00Z", lastError: null } as Thread["runtime"],
    latestRun: null, hasPendingApprovals: false, hasPendingUserInput: false, pendingBackgroundTasks: [], ...overrides };
}
it.each(["preparing", "queued", "starting", "running", "waiting"])("blocks %s native work", (status) => {
  expect(isThreadBlockingIdleRestart(thread(status))).toBe(true);
});
it("allows idle threads and user-input waits", () => {
  expect(isThreadBlockingIdleRestart(thread())).toBe(false);
  expect(isThreadBlockingIdleRestart(thread("waiting", { hasPendingUserInput: true }))).toBe(false);
  expect(isThreadBlockingIdleRestart(thread("waiting", { hasPendingApprovals: true }))).toBe(false);
});
it("keeps server-owned queued runs blocking during the runtime gap", () => {
  expect(isThreadBlockingIdleRestart(thread("idle", { latestRun: { runId: RunId.make("queued"), status: "queued", requestedAt: "2026-10-05T00:00:00Z", startedAt: null, completedAt: null, assistantMessageId: null } }))).toBe(true);
});
it("counts only desktop-hosted agents and includes background work", () => {
  expect(countAgentsBlockingIdleRestart({ threads: [thread("running"), thread("running", { environmentId: REMOTE }),
    thread("idle", { pendingBackgroundTasks: [{ taskId: "devserver", kind: "command" }] })], localEnvironmentIds: new Set([LOCAL]) })).toBe(2);
});
it("renders singular and plural restart intent", () => {
  expect(idleRestartTooltip(1)).toContain("when 1 agent finishes");
  expect(idleRestartTooltip(3)).toContain("when 3 agents finish");
});
