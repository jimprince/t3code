// @vitest-environment jsdom
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import type { RuntimeSubagent } from "@t3tools/client-runtime/state/subagentRuntime";
import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

vi.mock("@tanstack/react-router", () => ({ useRouter: () => ({ navigate: vi.fn() }) }));
vi.mock("~/hooks/useThreadNesting", () => ({
  useThreadNestingActions: () => ({ setThreadParent: vi.fn() }),
}));
const entities = vi.hoisted(() => ({
  parentProjectId: null as string | null,
  providers: [] as { instanceId: string; displayName: string }[],
}));

vi.mock("~/state/entities", () => ({
  useProject: () => ({ title: "Worker project" }),
  useThreadShell: () =>
    entities.parentProjectId === null ? null : { projectId: entities.parentProjectId },
  useServerConfigs: () => new Map([["env-a", { providers: entities.providers }]]),
  useThreadShellsForProjectRefs: () => [],
}));
vi.mock("~/hooks/useLocalStorage", () => ({
  useLocalStorage: <T,>(_key: string, initialValue: T) => useState(initialValue),
}));

import { AgentsPanelEntries } from "./AgentsPanelEntries";

const environmentId = EnvironmentId.make("env-a");
const parentId = ThreadId.make("parent");

function thread(id: string, settled: boolean): EnvironmentThreadShell {
  return {
    id: ThreadId.make(id),
    environmentId,
    projectId: ProjectId.make("worker-project"),
    title: `Thread ${id}`,
    createdAt: "2026-09-20T00:00:00.000Z",
    updatedAt: "2026-09-20T00:00:00.000Z",
    latestUserMessageAt: null,
    latestTurn: null,
    modelSelection: { model: "claude-opus-5-5" },
    settledOverride: settled ? "settled" : null,
    settledAt: settled ? "2026-09-21T00:00:00.000Z" : null,
  } as unknown as EnvironmentThreadShell;
}

function spawn(id: string, status: RuntimeSubagent["status"]): RuntimeSubagent {
  return {
    id,
    status,
    firstSeenAt: "2026-09-20T01:00:00.000Z",
    completedAt: status === "running" ? null : "2026-09-22T00:00:00.000Z",
    updatedAt: "2026-09-22T00:00:00.000Z",
  } as unknown as RuntimeSubagent;
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  entities.parentProjectId = null;
  entities.providers = [];
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function render(directAgents: ReadonlyArray<RuntimeSubagent>) {
  act(() => {
    root.render(
      <AgentsPanelEntries
        environmentId={environmentId}
        threadId={parentId}
        threads={[thread("live", false), thread("done", true)]}
        workflows={[]}
        directAgents={directAgents}
        renderWorkflow={() => null}
        renderAgent={(agent) => <div>{`Spawn ${agent.id}`}</div>}
      />,
    );
  });
}

it("folds settled rows into a collapsed Settled shelf", () => {
  render([spawn("working", "running"), spawn("finished", "completed")]);

  const text = container.textContent ?? "";
  expect(text).toContain("Thread live");
  expect(text).toContain("Worker project");
  expect(text).toContain("Spawn working");
  expect(text).not.toContain("Thread done");
  expect(text).not.toContain("Spawn finished");
  expect(text).toContain("Settled (2)");
  expect(text).not.toMatch(/Threads|Direct spawns/);

  const shelf = container.querySelector<HTMLButtonElement>("button[aria-expanded='false']");
  act(() => shelf?.click());
  expect(container.textContent).toContain("Thread done");
  expect(container.textContent).toContain("Spawn finished");
});

it("keeps a row that finishes while watching in place", () => {
  render([spawn("working", "running")]);
  expect(container.textContent).toContain("Settled (1)");

  render([spawn("working", "completed")]);

  expect(container.textContent).toContain("Spawn working");
  expect(container.textContent).toContain("Settled (1)");
});

it("shows nested-worker state, output, effort, pool, metrics, duration, activity and workspace", () => {
  const worker = {
    ...thread("rich", false),
    hasPendingApprovals: false,
    hasPendingUserInput: true,
    branch: "fix/gripper",
    worktreePath: "/tmp/gripper-worker",
    modelSelection: {
      instanceId: "codex_personal",
      model: "gpt-6.1-sol",
      options: [{ id: "reasoningEffort", value: "high" }],
    },
    latestTurn: {
      state: "completed",
      startedAt: "2026-10-01T00:00:00Z",
      requestedAt: "2026-10-01T00:00:00Z",
      completedAt: "2026-10-01T00:02:05Z",
    },
    agentPanelSummary: {
      latestOutput: "Checking the gripper\nHidden second line",
      processedTokens: 7500,
      contextTokens: 2000,
      toolCalls: 3,
      lastActivityAt: "2026-10-01T00:01:00Z",
    },
  } as unknown as EnvironmentThreadShell;
  const renderWorker = (value: EnvironmentThreadShell) =>
    act(() =>
      root.render(
        <AgentsPanelEntries
          environmentId={environmentId}
          threadId={parentId}
          threads={[value]}
          workflows={[]}
          directAgents={[]}
          renderWorkflow={() => null}
          renderAgent={() => null}
        />,
      ),
    );
  renderWorker(worker);
  const text = container.textContent!;
  for (const value of [
    "Needs input",
    "Checking the gripper",
    "gpt-6.1-sol",
    "high",
    "codex_personal",
    "7.5k tok",
    "3 tools",
    "2m 05s",
    "activity",
    "fix/gripper",
    "/tmp/gripper-worker",
    "Worker project",
  ])
    expect(text).toContain(value);
  expect(text).not.toContain("Hidden second line");
  expect(container.querySelector('[aria-label="Needs input"]')).not.toBeNull();
  renderWorker({ ...worker, hasPendingUserInput: false });
  expect(container.textContent).toContain("Completed");
  renderWorker({
    ...worker,
    hasPendingUserInput: false,
    session: { status: "running" },
  } as EnvironmentThreadShell);
  expect(container.querySelector('[aria-label="Working"]')).not.toBeNull();
  renderWorker({
    ...worker,
    hasPendingUserInput: false,
    session: { status: "error", lastError: "Provider disconnected" },
  } as EnvironmentThreadShell);
  expect(container.querySelector('[aria-label="Error"]')).not.toBeNull();
  entities.parentProjectId = worker.projectId;
  entities.providers = [{ instanceId: "codex_personal", displayName: "Personal Codex" }];
  renderWorker({ ...worker, hasPendingUserInput: false });
  expect(container.textContent).toContain("Personal Codex");
  expect(container.textContent).not.toContain("Worker project");
  renderWorker({ ...worker, hasPendingUserInput: false, settledOverride: "settled" });
  expect(container.textContent).toContain("Settled");
});
