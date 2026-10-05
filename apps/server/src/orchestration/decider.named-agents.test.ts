import {
  CommandId,
  EnvironmentId,
  NamedAgentName,
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

const NOW = "2026-10-03T00:00:00.000Z";
const AGENT_PROJECT = ProjectId.make("agent-printer");
const PLAIN_PROJECT = ProjectId.make("plain");
const LIVE = ThreadId.make("printer-1");
const NEXT = ThreadId.make("printer-2");
const SUB = ThreadId.make("printer-sub");
const MODEL = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" };

function thread(id: ThreadId, overrides: Partial<OrchestrationThread> = {}): OrchestrationThread {
  return {
    id,
    projectId: AGENT_PROJECT,
    title: String(id),
    modelSelection: MODEL,
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
    projects: [AGENT_PROJECT, PLAIN_PROJECT].map((id) => ({
      id,
      title: String(id),
      workspaceRoot: `/srv/${id}`,
      defaultModelSelection: null,
      scripts: [],
      ...(id === AGENT_PROJECT ? { permanentAgent: { name: NamedAgentName.make("printer") } } : {}),
      createdAt: NOW,
      updatedAt: NOW,
      deletedAt: null,
    })),
    threads: [...threads],
    updatedAt: NOW,
  };
}

const create = (
  threadId: ThreadId,
  extra: Partial<Extract<OrchestrationCommand, { type: "thread.create" }>> = {},
): OrchestrationCommand => ({
  type: "thread.create",
  commandId: CommandId.make(`create-${threadId}`),
  threadId,
  projectId: AGENT_PROJECT,
  title: "printer",
  modelSelection: MODEL,
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  createdAt: NOW,
  ...extra,
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

const liveRoots = (model: OrchestrationReadModel) =>
  model.threads
    .filter(
      (entry) =>
        entry.projectId === AGENT_PROJECT &&
        entry.archivedAt === null &&
        (entry.parentThreadId ?? null) === null &&
        entry.remoteParent == null,
    )
    .map((entry) => entry.id);

it.layer(NodeServices.layer)("named agents", (it) => {
  it.effect("starts a dormant agent with auto-settle disabled, then refuses a second root", () =>
    Effect.gen(function* () {
      const started = yield* decideAndProject(create(LIVE), readModel([]));
      expect(liveRoots(started)).toEqual([LIVE]);
      expect(started.threads[0]?.autoSettleDisabledAt).toBe(NOW);

      expect(yield* rejection(create(NEXT), started)).toContain("already has a live thread");
      const withSub = yield* decideAndProject(create(SUB, { parentThreadId: LIVE }), started);
      expect(liveRoots(withSub)).toEqual([LIVE]);
      expect(withSub.threads.find((entry) => entry.id === SUB)?.autoSettleDisabledAt).toBeFalsy();
      const remoteParent = { environmentId: EnvironmentId.make("vm"), threadId: LIVE };
      const withRemote = yield* decideAndProject(create(NEXT, { remoteParent }), withSub);
      expect(liveRoots(withRemote)).toEqual([LIVE]);
      expect(withRemote.threads.find((entry) => entry.id === NEXT)?.remoteParent).toEqual(
        remoteParent,
      );
      expect(
        withRemote.threads.find((entry) => entry.id === NEXT)?.autoSettleDisabledAt,
      ).toBeFalsy();
    }),
  );

  it.effect("leaves plain projects unrestricted", () =>
    Effect.gen(function* () {
      const plain = { projectId: PLAIN_PROJECT };
      const first = yield* decideAndProject(create(LIVE, plain), readModel([]));
      const second = yield* decideAndProject(create(NEXT, plain), first);
      expect(second.threads).toHaveLength(2);
    }),
  );

  it.effect("guards unarchive, unnest and import while an incarnation is live", () =>
    Effect.gen(function* () {
      const model = readModel([
        thread(LIVE),
        thread(NEXT, { archivedAt: NOW }),
        thread(SUB, { parentThreadId: LIVE }),
      ]);

      expect(
        yield* rejection(
          { type: "thread.unarchive", commandId: CommandId.make("unarchive"), threadId: NEXT },
          model,
        ),
      ).toContain("already has a live thread");
      expect(
        yield* rejection(
          {
            type: "thread.parent.set",
            commandId: CommandId.make("unnest"),
            threadId: SUB,
            parentThreadId: null,
          },
          model,
        ),
      ).toContain("already has a live thread");
      expect(
        yield* rejection(
          {
            type: "thread.import",
            commandId: CommandId.make("import"),
            threadId: ThreadId.make("moved-in"),
            projectId: AGENT_PROJECT,
            thread: {
              id: ThreadId.make("moved-in"),
              title: "moved",
              modelSelection: MODEL,
              runtimeMode: "full-access",
              interactionMode: "default",
              branch: null,
              goal: null,
              createdAt: NOW,
              updatedAt: NOW,
              messages: [],
              proposedPlans: [],
              activities: [],
              checkpoints: [],
            },
            branch: null,
            worktreePath: null,
            createdAt: NOW,
          },
          model,
        ),
      ).toContain("already has a live thread");

      const dormant = readModel([thread(NEXT, { archivedAt: NOW })]);
      const revived = yield* decideAndProject(
        { type: "thread.unarchive", commandId: CommandId.make("unarchive"), threadId: NEXT },
        dormant,
      );
      expect(liveRoots(revived)).toEqual([NEXT]);
    }),
  );

  it.effect("hands over atomically, only from the idle live incarnation", () =>
    Effect.gen(function* () {
      const handedOver = yield* decideAndProject(
        create(NEXT, { handoverFromThreadId: LIVE }),
        readModel([thread(LIVE)]),
      );
      expect(liveRoots(handedOver)).toEqual([NEXT]);
      expect(handedOver.threads.find((entry) => entry.id === LIVE)?.archivedAt).toBe(NOW);

      const busy = readModel([
        thread(LIVE, {
          session: {
            threadId: LIVE,
            status: "running",
            providerName: "codex",
            runtimeMode: "full-access",
            activeTurnId: null,
            lastError: null,
            updatedAt: NOW,
          },
        }),
      ]);
      expect(yield* rejection(create(NEXT, { handoverFromThreadId: LIVE }), busy)).toContain(
        "is busy",
      );
      expect(
        yield* rejection(
          create(NEXT, { handoverFromThreadId: SUB }),
          readModel([thread(LIVE), thread(SUB, { parentThreadId: LIVE })]),
        ),
      ).toContain("only hand over from its live thread");
      expect(
        yield* rejection(
          create(NEXT, { projectId: PLAIN_PROJECT, handoverFromThreadId: LIVE }),
          readModel([thread(LIVE)]),
        ),
      ).toContain("Only a named agent");
    }),
  );

  it.effect("keeps the live incarnation out of automatic settlement", () =>
    Effect.gen(function* () {
      expect(
        yield* rejection(
          {
            type: "thread.auto-settle.set",
            commandId: CommandId.make("enable"),
            threadId: LIVE,
            enabled: true,
          },
          readModel([thread(LIVE, { autoSettleDisabledAt: NOW })]),
        ),
      ).toContain("cannot settle automatically");
    }),
  );

  it.effect("keeps names unique and refuses to name a project with several live roots", () =>
    Effect.gen(function* () {
      const name = (projectId: ProjectId): OrchestrationCommand => ({
        type: "project.meta.update",
        commandId: CommandId.make(`name-${projectId}`),
        projectId,
        permanentAgent: { name: NamedAgentName.make("printer") },
      });
      expect(yield* rejection(name(PLAIN_PROJECT), readModel([]))).toContain("already exists");

      const crowded = readModel([
        thread(LIVE, { projectId: PLAIN_PROJECT }),
        thread(NEXT, { projectId: PLAIN_PROJECT }),
      ]);
      const renamed = {
        ...name(PLAIN_PROJECT),
        permanentAgent: { name: NamedAgentName.make("deploy") },
      } as OrchestrationCommand;
      expect(yield* rejection(renamed, crowded)).toContain("several live top-level threads");

      const named = yield* decideAndProject(renamed, readModel([]));
      expect(
        named.projects.find((project) => project.id === PLAIN_PROJECT)?.permanentAgent,
      ).toEqual({ name: "deploy" });
    }),
  );
});
