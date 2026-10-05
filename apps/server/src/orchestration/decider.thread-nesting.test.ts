import {
  CommandId,
  EnvironmentId,
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

const setParent = (
  threadId: ThreadId,
  parentThreadId: ThreadId | null,
): Extract<OrchestrationCommand, { type: "thread.parent.set" }> => ({
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
  it.effect("stores a remote parent without requiring a local parent and clears it on unnest", () =>
    Effect.gen(function* () {
      const remoteParent = { environmentId: EnvironmentId.make("vm"), threadId: ORCHESTRATOR };
      const nested = yield* decideAndProject(
        { ...setParent(WORKER, null), remoteParent },
        readModel([thread(WORKER)]),
      );
      expect(nested.threads[0]?.remoteParent).toEqual(remoteParent);
      expect(nested.threads[0]?.parentThreadId).toBeNull();
      const unnested = yield* decideAndProject(setParent(WORKER, null), nested);
      expect(unnested.threads[0]?.remoteParent).toBeNull();
      expect(
        yield* rejection(
          { ...setParent(WORKER, ORCHESTRATOR), remoteParent },
          readModel([thread(WORKER), thread(ORCHESTRATOR)]),
        ),
      ).toContain("not both");
    }),
  );

  it.effect("creates nested threads in the same or a different project", () =>
    Effect.gen(function* () {
      for (const projectId of [PROJECT, OTHER_PROJECT]) {
        const next = yield* decideAndProject(
          {
            type: "thread.create",
            commandId: CommandId.make("cmd-create"),
            threadId: WORKER,
            projectId,
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
        expect(next.threads.find((entry) => entry.id === WORKER)?.parentThreadId).toBe(
          ORCHESTRATOR,
        );
      }
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

  it.effect("settling or archiving a parent does not stop or settle its working child", () =>
    Effect.gen(function* () {
      const child = thread(WORKER, {
        parentThreadId: ORCHESTRATOR,
        session: {
          threadId: WORKER,
          status: "running",
          providerName: "codex",
          runtimeMode: "full-access",
          activeTurnId: null,
          lastError: null,
          updatedAt: NOW,
        },
      });
      const nested = readModel([thread(ORCHESTRATOR), child]);
      const settled = yield* decideAndProject(
        {
          type: "thread.settle",
          commandId: CommandId.make("settle-parent"),
          threadId: ORCHESTRATOR,
        },
        nested,
      );
      expect(settled.threads.find((entry) => entry.id === ORCHESTRATOR)?.settledOverride).toBe(
        "settled",
      );
      expect(settled.threads.find((entry) => entry.id === WORKER)).toMatchObject({
        parentThreadId: ORCHESTRATOR,
        settledOverride: null,
        archivedAt: null,
        session: { status: "running" },
      });

      const archived = yield* decideAndProject(
        {
          type: "thread.archive",
          commandId: CommandId.make("archive-parent"),
          threadId: ORCHESTRATOR,
        },
        settled,
      );
      expect(archived.threads.find((entry) => entry.id === WORKER)).toMatchObject({
        parentThreadId: ORCHESTRATOR,
        settledOverride: null,
        archivedAt: null,
        session: { status: "running" },
      });
    }),
  );

  it.effect(
    "re-nests across projects and preserves the child's execution workspace after parent removal",
    () =>
      Effect.gen(function* () {
        const child = thread(WORKER, {
          projectId: OTHER_PROJECT,
          branch: "worker-branch",
          worktreePath: "/tmp/worker-worktree",
        });
        const nested = yield* decideAndProject(
          setParent(WORKER, ORCHESTRATOR),
          readModel([thread(ORCHESTRATOR), child]),
        );
        expect(nested.threads.find((entry) => entry.id === WORKER)).toMatchObject({
          projectId: OTHER_PROJECT,
          parentThreadId: ORCHESTRATOR,
          branch: child.branch,
          worktreePath: child.worktreePath,
        });
        const archived = yield* decideAndProject(
          {
            type: "thread.archive",
            commandId: CommandId.make("archive-parent"),
            threadId: ORCHESTRATOR,
          },
          nested,
        );
        expect(archived.threads.find((entry) => entry.id === WORKER)).toMatchObject({
          archivedAt: null,
          projectId: OTHER_PROJECT,
          worktreePath: child.worktreePath,
        });
        const removed = yield* decideAndProject(
          {
            type: "project.delete",
            commandId: CommandId.make("remove-parent-project"),
            projectId: PROJECT,
            force: true,
          },
          nested,
        );
        expect(removed.threads.find((entry) => entry.id === WORKER)).toMatchObject({
          projectId: OTHER_PROJECT,
          deletedAt: null,
          branch: child.branch,
          worktreePath: child.worktreePath,
        });
        const unnested = yield* decideAndProject(setParent(WORKER, null), removed);
        expect(unnested.threads.find((entry) => entry.id === WORKER)?.parentThreadId).toBeNull();
      }),
  );

  it.effect("allows deep trees and rejects cycles and archived parents", () =>
    Effect.gen(function* () {
      const nestedParent = readModel([
        thread(ORCHESTRATOR, { parentThreadId: ThreadId.make("top") }),
        thread(ThreadId.make("top")),
        thread(WORKER),
      ]);
      const deeper = yield* decideAndProject(setParent(WORKER, ORCHESTRATOR), nestedParent);
      expect(deeper.threads.find((entry) => entry.id === WORKER)?.parentThreadId).toBe(
        ORCHESTRATOR,
      );

      const hasChildren = readModel([
        thread(ORCHESTRATOR),
        thread(WORKER, { parentThreadId: ORCHESTRATOR }),
        thread(ThreadId.make("other")),
      ]);
      const movedBranch = yield* decideAndProject(
        setParent(ORCHESTRATOR, ThreadId.make("other")),
        hasChildren,
      );
      expect(movedBranch.threads.find((entry) => entry.id === ORCHESTRATOR)?.parentThreadId).toBe(
        ThreadId.make("other"),
      );
      expect(yield* rejection(setParent(ThreadId.make("other"), WORKER), movedBranch)).toContain(
        "descendants",
      );

      const self = readModel([thread(WORKER)]);
      expect(yield* rejection(setParent(WORKER, WORKER), self)).toContain("under itself");

      const archivedParent = readModel([thread(ORCHESTRATOR, { archivedAt: NOW }), thread(WORKER)]);
      expect(yield* rejection(setParent(WORKER, ORCHESTRATOR), archivedParent)).toContain(
        "archived",
      );
    }),
  );
});
