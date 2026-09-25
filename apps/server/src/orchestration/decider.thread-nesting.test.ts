import {
  CommandId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationCommand,
  type OrchestrationReadModel,
  type OrchestrationThread,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { decideOrchestrationCommand } from "./decider.ts";
import { projectEvent } from "./projector.ts";

const NOW = "2026-01-01T00:00:00.000Z";
const PROJECT = ProjectId.make("project-1");
const OTHER_PROJECT = ProjectId.make("project-2");
const ORCHESTRATOR = ThreadId.make("orchestrator");
const WORKER = ThreadId.make("worker");

function thread(id: ThreadId, overrides: Partial<OrchestrationThread> = {}): OrchestrationThread {
  return {
    id,
    projectId: PROJECT,
    title: String(id),
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    pullRequests: [],
    branch: null,
    worktreePath: null,
    latestTurn: null,
    createdAt: NOW,
    updatedAt: NOW,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    unsettledAt: null,
    activeOrderKey: null,
    parentThreadId: null,
    snoozedUntil: null,
    snoozedAt: null,
    pinnedAt: null,
    pinOrderKey: null,
    deletedAt: null,
    messages: [],
    proposedPlans: [],
    activities: [],
    checkpoints: [],
    session: null,
    ...overrides,
  };
}

function readModel(threads: ReadonlyArray<OrchestrationThread>): OrchestrationReadModel {
  return {
    snapshotSequence: 0,
    projects: [PROJECT, OTHER_PROJECT].map((id) => ({
      id,
      title: String(id),
      workspaceRoot: `/tmp/${id}`,
      defaultModelSelection: null,
      scripts: [],
      createdAt: NOW,
      updatedAt: NOW,
      deletedAt: null,
    })),
    threads: [...threads],
    updatedAt: NOW,
  };
}

const setParent = (threadId: ThreadId, parentThreadId: ThreadId | null): OrchestrationCommand => ({
  type: "thread.parent.set",
  commandId: CommandId.make(`cmd-${threadId}`),
  threadId,
  parentThreadId,
});

const decideAndProject = (command: OrchestrationCommand, model: OrchestrationReadModel) =>
  Effect.gen(function* () {
    const decided = yield* decideOrchestrationCommand({ command, readModel: model });
    let next = model;
    for (const event of Array.isArray(decided) ? decided : [decided]) {
      next = yield* projectEvent(next, { ...event, sequence: next.snapshotSequence + 1 });
    }
    return next;
  });

const rejection = (command: OrchestrationCommand, model: OrchestrationReadModel) =>
  decideOrchestrationCommand({ command, readModel: model }).pipe(
    Effect.flip,
    Effect.map((error) => String((error as { detail?: string }).detail)),
  );

it.layer(NodeServices.layer)("thread nesting", (it) => {
  it.effect("creates a thread nested under its orchestrator", () =>
    Effect.gen(function* () {
      const next = yield* decideAndProject(
        {
          type: "thread.create",
          commandId: CommandId.make("cmd-create"),
          threadId: WORKER,
          projectId: PROJECT,
          title: "Worker",
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdAt: NOW,
          parentThreadId: ORCHESTRATOR,
        },
        readModel([thread(ORCHESTRATOR)]),
      );
      expect(next.threads.find((entry) => entry.id === WORKER)?.parentThreadId).toBe(ORCHESTRATOR);
    }),
  );

  it.effect("moves a thread under a parent and back to the sidebar without touching activity", () =>
    Effect.gen(function* () {
      const nested = yield* decideAndProject(
        setParent(WORKER, ORCHESTRATOR),
        readModel([thread(ORCHESTRATOR), thread(WORKER)]),
      );
      const worker = nested.threads.find((entry) => entry.id === WORKER);
      expect(worker?.parentThreadId).toBe(ORCHESTRATOR);
      expect(worker?.updatedAt).toBe(NOW);

      const unnested = yield* decideAndProject(setParent(WORKER, null), nested);
      expect(unnested.threads.find((entry) => entry.id === WORKER)?.parentThreadId).toBeNull();
    }),
  );

  it.effect("rejects nesting that would make a tree, a cycle, or cross projects", () =>
    Effect.gen(function* () {
      const nestedParent = readModel([
        thread(ORCHESTRATOR, { parentThreadId: ThreadId.make("top") }),
        thread(ThreadId.make("top")),
        thread(WORKER),
      ]);
      expect(yield* rejection(setParent(WORKER, ORCHESTRATOR), nestedParent)).toContain(
        "one level deep",
      );

      const hasChildren = readModel([
        thread(ORCHESTRATOR),
        thread(WORKER, { parentThreadId: ORCHESTRATOR }),
        thread(ThreadId.make("other")),
      ]);
      expect(
        yield* rejection(setParent(ORCHESTRATOR, ThreadId.make("other")), hasChildren),
      ).toContain("nested threads of its own");

      const self = readModel([thread(WORKER)]);
      expect(yield* rejection(setParent(WORKER, WORKER), self)).toContain("under itself");

      const crossProject = readModel([
        thread(ORCHESTRATOR, { projectId: OTHER_PROJECT }),
        thread(WORKER),
      ]);
      expect(yield* rejection(setParent(WORKER, ORCHESTRATOR), crossProject)).toContain(
        "same project",
      );

      const archivedParent = readModel([thread(ORCHESTRATOR, { archivedAt: NOW }), thread(WORKER)]);
      expect(yield* rejection(setParent(WORKER, ORCHESTRATOR), archivedParent)).toContain(
        "archived",
      );
    }),
  );
});
