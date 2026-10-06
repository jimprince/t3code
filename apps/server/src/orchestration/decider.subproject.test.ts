import {
  CommandId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationCommand,
  type OrchestrationReadModel,
  type OrchestrationThread,
  type ThreadSubprojectMode,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  AUTO_PROMOTE_SUBPROJECTS,
  decideOrchestrationCommand,
  subprojectToPromote,
} from "./decider.ts";
import { projectEvent } from "./projector.ts";

const NOW = "2026-01-01T00:00:00.000Z";
const LATER = "2026-01-02T00:00:00.000Z";
const PROJECT = ProjectId.make("project-1");
const TOP = ThreadId.make("top");
const MID = ThreadId.make("mid");
const CHILD = ThreadId.make("child");

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
    projects: [
      {
        id: PROJECT,
        title: "Project",
        workspaceRoot: "/tmp/project",
        defaultModelSelection: null,
        scripts: [],
        createdAt: NOW,
        updatedAt: NOW,
        deletedAt: null,
      },
    ],
    threads: [...threads],
    updatedAt: NOW,
  };
}

const createChild = (parentThreadId: ThreadId): OrchestrationCommand => ({
  type: "thread.create",
  commandId: CommandId.make("cmd-create"),
  threadId: CHILD,
  projectId: PROJECT,
  title: "Child",
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  createdAt: LATER,
  parentThreadId,
});

const setMode = (threadId: ThreadId, mode: ThreadSubprojectMode): OrchestrationCommand => ({
  type: "thread.subproject.set",
  commandId: CommandId.make(`cmd-mode-${mode}`),
  threadId,
  mode,
});

const decide = (command: OrchestrationCommand, model: OrchestrationReadModel) =>
  decideOrchestrationCommand({ command, readModel: model }).pipe(
    Effect.map((decided) => (Array.isArray(decided) ? decided : [decided])),
  );

const decideAndProject = (command: OrchestrationCommand, model: OrchestrationReadModel) =>
  Effect.gen(function* () {
    let next = model;
    for (const event of yield* decide(command, model)) {
      next = yield* projectEvent(next, { ...event, sequence: next.snapshotSequence + 1 });
    }
    return next;
  });

const modeOf = (model: OrchestrationReadModel, id: ThreadId) =>
  model.threads.find((entry) => entry.id === id)?.subproject;

it.layer(NodeServices.layer)("thread subprojects", (it) => {
  it.effect("thread.subproject.set stores each mode and re-setting one keeps updatedAt", () =>
    Effect.gen(function* () {
      const model = readModel([thread(TOP), thread(MID, { parentThreadId: TOP })]);
      const on = yield* decideAndProject(setMode(MID, "on"), model);
      expect(modeOf(on, MID)).toBe("on");
      const again = yield* decideAndProject(setMode(MID, "on"), on);
      expect(again.threads.find((entry) => entry.id === MID)?.updatedAt).toBe(
        on.threads.find((entry) => entry.id === MID)?.updatedAt,
      );
      expect(modeOf(yield* decideAndProject(setMode(MID, "off"), on), MID)).toBe("off");
      expect(modeOf(yield* decideAndProject(setMode(MID, "auto"), on), MID)).toBe("auto");
    }),
  );

  it.effect("a top-level thread stores a mode without any other change", () =>
    Effect.gen(function* () {
      const next = yield* decideAndProject(setMode(TOP, "on"), readModel([thread(TOP)]));
      expect(modeOf(next, TOP)).toBe("on");
      expect(next.threads[0]?.parentThreadId).toBeNull();
    }),
  );

  it.effect("creating a child promotes nothing while auto-promotion is off", () =>
    Effect.gen(function* () {
      // Inert until the subprojects UI ships (AUTO_PROMOTE_SUBPROJECTS).
      expect(AUTO_PROMOTE_SUBPROJECTS).toBe(false);
      const model = readModel([thread(TOP), thread(MID, { parentThreadId: TOP })]);
      const events = yield* decide(createChild(MID), model);
      expect(events.map((event) => event.type)).toEqual(["thread.created"]);
      expect(modeOf(yield* decideAndProject(createChild(MID), model), MID)).toBeUndefined();
    }),
  );

  it("a nested thread on auto, absent or explicit, is the one a child would promote", () => {
    for (const subproject of [undefined, "auto"] as const) {
      const mid = thread(MID, { parentThreadId: TOP, ...(subproject ? { subproject } : {}) });
      expect(subprojectToPromote(readModel([thread(TOP), mid]), MID)?.id).toBe(MID);
    }
  });

  it("off blocks promotion and on is already promoted", () => {
    for (const subproject of ["off", "on"] as const) {
      const model = readModel([thread(TOP), thread(MID, { parentThreadId: TOP, subproject })]);
      expect(subprojectToPromote(model, MID)).toBeUndefined();
    }
  });

  it("a top-level parent or no parent is never promoted", () => {
    const model = readModel([thread(TOP)]);
    expect(subprojectToPromote(model, TOP)).toBeUndefined();
    expect(subprojectToPromote(model, null)).toBeUndefined();
  });
});
