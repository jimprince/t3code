// @vitest-environment jsdom
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import type { RuntimeSubagent } from "@t3tools/client-runtime/state/subagentRuntime";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

vi.mock("@tanstack/react-router", () => ({ useRouter: () => ({ navigate: vi.fn() }) }));
vi.mock("~/hooks/useThreadNesting", () => ({
  useThreadNestingActions: () => ({ setThreadParent: vi.fn() }),
}));
vi.mock("~/state/entities", () => ({
  useProject: () => ({ title: "Worker project" }),
  useThreadShell: () => null,
  useThreadShellsForProjectRefs: () => [],
}));
vi.mock("~/hooks/useLocalStorage", () => ({
  useLocalStorage: <T,>(_key: string, initialValue: T) => useState(initialValue),
}));
vi.mock("./Sidebar.logic", () => ({
  resolveThreadStatusPill: () => null,
  resolveSidebarThreadStatus: () => "idle",
}));

import { AgentsPanelEntries } from "./AgentsPanelEntries";

const environmentId = EnvironmentId.make("env-a");
const parentId = ThreadId.make("parent");

function thread(id: string, settled: boolean): EnvironmentThreadShell {
  return {
    id: ThreadId.make(id),
    environmentId,
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
