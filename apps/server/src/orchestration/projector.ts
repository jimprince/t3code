import type { OrchestrationEvent, OrchestrationReadModel, ThreadId } from "@t3tools/contracts";
import {
  OrchestrationCheckpointSummary,
  OrchestrationMessage,
  OrchestrationSession,
  OrchestrationThread,
} from "@t3tools/contracts";
import { Effect, Schema } from "effect";

import { toProjectorDecodeError, type OrchestrationProjectorDecodeError } from "./Errors.ts";
import {
  MessageSentPayloadSchema,
  ProjectCreatedPayload,
  ProjectDeletedPayload,
  ProjectMetaUpdatedPayload,
  ThreadActivityAppendedPayload,
  ThreadArchivedPayload,
  ThreadCreatedPayload,
  ThreadDeletedPayload,
  ThreadInteractionModeSetPayload,
  ThreadMetaUpdatedPayload,
  ThreadProposedPlanUpsertedPayload,
  ThreadRuntimeModeSetPayload,
  ThreadUnarchivedPayload,
  ThreadRevertedPayload,
  ThreadSessionSetPayload,
  ThreadTurnStartRequestedPayload,
  ThreadTurnDiffCompletedPayload,
} from "./Schemas.ts";

type ThreadPatch = Partial<Omit<OrchestrationThread, "id" | "projectId">>;
const MAX_THREAD_MESSAGES = 2_000;
const MAX_THREAD_CHECKPOINTS = 500;

type PendingTurnStartMetadata = {
  requestedAt: string;
  sourceProposedPlan?: {
    threadId: ThreadId;
    planId: string;
  };
};

type LatestTurnSnapshot = NonNullable<OrchestrationThread["latestTurn"]>;
type LatestTurnSnapshotStore = Map<ThreadId, Map<string, LatestTurnSnapshot>>;

const pendingTurnStartMetadataByModel = new WeakMap<
  OrchestrationReadModel,
  Map<ThreadId, PendingTurnStartMetadata>
>();
const latestTurnSnapshotsByModel = new WeakMap<OrchestrationReadModel, LatestTurnSnapshotStore>();

function checkpointStatusToLatestTurnState(status: "ready" | "missing" | "error") {
  if (status === "error") return "error" as const;
  if (status === "missing") return "interrupted" as const;
  return "completed" as const;
}

function sessionStatusToLatestTurnState(status: OrchestrationSession["status"]) {
  if (status === "interrupted") return "interrupted" as const;
  if (status === "error") return "error" as const;
  return "running" as const;
}

function cloneLatestTurn(
  latestTurn: OrchestrationThread["latestTurn"],
): OrchestrationThread["latestTurn"] {
  if (latestTurn === null) {
    return null;
  }

  return {
    ...latestTurn,
    ...(latestTurn.sourceProposedPlan !== undefined
      ? { sourceProposedPlan: { ...latestTurn.sourceProposedPlan } }
      : {}),
  };
}

function cloneLatestTurnSnapshotStore(model: OrchestrationReadModel): LatestTurnSnapshotStore {
  return new Map(
    Array.from(latestTurnSnapshotsByModel.get(model)?.entries() ?? [], ([threadId, snapshots]) => [
      threadId,
      new Map(
        Array.from(snapshots.entries(), ([turnId, snapshot]) => [
          turnId,
          cloneLatestTurn(snapshot) as LatestTurnSnapshot,
        ]),
      ),
    ]),
  );
}

function recordLatestTurnSnapshot(
  store: LatestTurnSnapshotStore,
  threadId: ThreadId,
  latestTurn: OrchestrationThread["latestTurn"],
): void {
  if (latestTurn === null) {
    return;
  }

  const threadSnapshots = new Map(store.get(threadId)?.entries() ?? []);
  threadSnapshots.set(latestTurn.turnId, cloneLatestTurn(latestTurn) as LatestTurnSnapshot);
  store.set(threadId, threadSnapshots);
}

function retainLatestTurnSnapshotsAfterRevert(
  store: LatestTurnSnapshotStore,
  threadId: ThreadId,
  retainedTurnIds: ReadonlySet<string>,
): void {
  if (retainedTurnIds.size === 0) {
    store.delete(threadId);
    return;
  }

  const threadSnapshots = store.get(threadId);
  if (!threadSnapshots) {
    return;
  }

  const retainedSnapshots = new Map(
    Array.from(threadSnapshots.entries()).filter(([turnId]) => retainedTurnIds.has(turnId)),
  );

  if (retainedSnapshots.size === 0) {
    store.delete(threadId);
    return;
  }

  store.set(threadId, retainedSnapshots);
}

function compareLatestTurnSnapshots(left: LatestTurnSnapshot, right: LatestTurnSnapshot): number {
  const leftLatestAt = left.completedAt ?? left.startedAt ?? left.requestedAt;
  const rightLatestAt = right.completedAt ?? right.startedAt ?? right.requestedAt;
  return rightLatestAt.localeCompare(leftLatestAt) || right.turnId.localeCompare(left.turnId);
}

function latestTurnFallbackScore(snapshot: LatestTurnSnapshot): number {
  if (snapshot.completedAt !== null) {
    return 2;
  }
  return snapshot.startedAt !== null ? 1 : 0;
}

function selectFallbackLatestTurnSnapshot(
  snapshots: ReadonlyArray<LatestTurnSnapshot>,
): LatestTurnSnapshot | undefined {
  const completedOrSettledSnapshots = snapshots.filter((snapshot) => snapshot.completedAt !== null);
  const candidateSnapshots =
    completedOrSettledSnapshots.length > 0 ? completedOrSettledSnapshots : snapshots;

  return candidateSnapshots.toSorted(
    (left, right) =>
      latestTurnFallbackScore(right) - latestTurnFallbackScore(left) ||
      compareLatestTurnSnapshots(left, right),
  )[0];
}

function updateThread(
  threads: ReadonlyArray<OrchestrationThread>,
  threadId: ThreadId,
  patch: ThreadPatch,
): OrchestrationThread[] {
  return threads.map((thread) => (thread.id === threadId ? { ...thread, ...patch } : thread));
}

function decodeForEvent<A>(
  schema: Schema.Schema<A>,
  value: unknown,
  eventType: OrchestrationEvent["type"],
  field: string,
): Effect.Effect<A, OrchestrationProjectorDecodeError> {
  return Effect.try({
    try: () => Schema.decodeUnknownSync(schema as any)(value),
    catch: (error) => toProjectorDecodeError(`${eventType}:${field}`)(error as Schema.SchemaError),
  });
}

function retainThreadMessagesAfterRevert(
  messages: ReadonlyArray<OrchestrationMessage>,
  retainedTurnIds: ReadonlySet<string>,
  turnCount: number,
): ReadonlyArray<OrchestrationMessage> {
  const retainedMessageIds = new Set<string>();
  for (const message of messages) {
    if (message.role === "system") {
      retainedMessageIds.add(message.id);
      continue;
    }
    if (message.turnId !== null && retainedTurnIds.has(message.turnId)) {
      retainedMessageIds.add(message.id);
    }
  }

  const retainedUserCount = messages.filter(
    (message) => message.role === "user" && retainedMessageIds.has(message.id),
  ).length;
  const missingUserCount = Math.max(0, turnCount - retainedUserCount);
  if (missingUserCount > 0) {
    const fallbackUserMessages = messages
      .filter(
        (message) =>
          message.role === "user" &&
          !retainedMessageIds.has(message.id) &&
          (message.turnId === null || retainedTurnIds.has(message.turnId)),
      )
      .toSorted(
        (left, right) =>
          left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
      )
      .slice(0, missingUserCount);
    for (const message of fallbackUserMessages) {
      retainedMessageIds.add(message.id);
    }
  }

  const retainedAssistantCount = messages.filter(
    (message) => message.role === "assistant" && retainedMessageIds.has(message.id),
  ).length;
  const missingAssistantCount = Math.max(0, turnCount - retainedAssistantCount);
  if (missingAssistantCount > 0) {
    const fallbackAssistantMessages = messages
      .filter(
        (message) =>
          message.role === "assistant" &&
          !retainedMessageIds.has(message.id) &&
          (message.turnId === null || retainedTurnIds.has(message.turnId)),
      )
      .toSorted(
        (left, right) =>
          left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
      )
      .slice(0, missingAssistantCount);
    for (const message of fallbackAssistantMessages) {
      retainedMessageIds.add(message.id);
    }
  }

  return messages.filter((message) => retainedMessageIds.has(message.id));
}

function retainThreadActivitiesAfterRevert(
  activities: ReadonlyArray<OrchestrationThread["activities"][number]>,
  retainedTurnIds: ReadonlySet<string>,
): ReadonlyArray<OrchestrationThread["activities"][number]> {
  return activities.filter(
    (activity) => activity.turnId === null || retainedTurnIds.has(activity.turnId),
  );
}

function retainThreadProposedPlansAfterRevert(
  proposedPlans: ReadonlyArray<OrchestrationThread["proposedPlans"][number]>,
  retainedTurnIds: ReadonlySet<string>,
): ReadonlyArray<OrchestrationThread["proposedPlans"][number]> {
  return proposedPlans.filter(
    (proposedPlan) => proposedPlan.turnId === null || retainedTurnIds.has(proposedPlan.turnId),
  );
}

function compareThreadActivities(
  left: OrchestrationThread["activities"][number],
  right: OrchestrationThread["activities"][number],
): number {
  if (left.sequence !== undefined && right.sequence !== undefined) {
    if (left.sequence !== right.sequence) {
      return left.sequence - right.sequence;
    }
  } else if (left.sequence !== undefined) {
    return 1;
  } else if (right.sequence !== undefined) {
    return -1;
  }

  return left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id);
}

function latestTurnSourceProposedPlanPatch(
  latestTurn: OrchestrationThread["latestTurn"],
  turnId: string,
) {
  return latestTurn?.turnId === turnId && latestTurn.sourceProposedPlan !== undefined
    ? { sourceProposedPlan: latestTurn.sourceProposedPlan }
    : {};
}

function latestTurnStateAfterAssistantCompletion(
  latestTurn: OrchestrationThread["latestTurn"],
  turnId: string,
) {
  if (latestTurn?.turnId !== turnId) {
    return "completed" as const;
  }
  if (latestTurn.state === "interrupted") {
    return "interrupted" as const;
  }
  if (latestTurn.state === "error") {
    return "error" as const;
  }
  return "completed" as const;
}

function latestTurnStateAfterSessionSettlement(
  status: OrchestrationSession["status"],
): "completed" | "interrupted" | "error" {
  if (status === "interrupted") {
    return "interrupted";
  }
  if (status === "error") {
    return "error";
  }
  return "completed";
}

export function createEmptyReadModel(nowIso: string): OrchestrationReadModel {
  const model: OrchestrationReadModel = {
    snapshotSequence: 0,
    projects: [],
    threads: [],
    updatedAt: nowIso,
  };
  pendingTurnStartMetadataByModel.set(model, new Map());
  latestTurnSnapshotsByModel.set(model, new Map());
  return model;
}

export function projectEvent(
  model: OrchestrationReadModel,
  event: OrchestrationEvent,
): Effect.Effect<OrchestrationReadModel, OrchestrationProjectorDecodeError> {
  const pendingTurnStartByThread = new Map(
    pendingTurnStartMetadataByModel.get(model)?.entries() ?? [],
  );
  const latestTurnSnapshotsByThread = cloneLatestTurnSnapshotStore(model);

  const nextBase: OrchestrationReadModel = {
    ...model,
    snapshotSequence: event.sequence,
    updatedAt: event.occurredAt,
  };

  const projected = (() => {
    switch (event.type) {
      case "project.created":
        return decodeForEvent(ProjectCreatedPayload, event.payload, event.type, "payload").pipe(
          Effect.map((payload) => {
            const existing = nextBase.projects.find((entry) => entry.id === payload.projectId);
            const nextProject = {
              id: payload.projectId,
              title: payload.title,
              workspaceRoot: payload.workspaceRoot,
              defaultModelSelection: payload.defaultModelSelection,
              scripts: payload.scripts,
              createdAt: payload.createdAt,
              updatedAt: payload.updatedAt,
              deletedAt: null,
            };

            return {
              ...nextBase,
              projects: existing
                ? nextBase.projects.map((entry) =>
                    entry.id === payload.projectId ? nextProject : entry,
                  )
                : [...nextBase.projects, nextProject],
            };
          }),
        );

      case "project.meta-updated":
        return decodeForEvent(ProjectMetaUpdatedPayload, event.payload, event.type, "payload").pipe(
          Effect.map((payload) => ({
            ...nextBase,
            projects: nextBase.projects.map((project) =>
              project.id === payload.projectId
                ? {
                    ...project,
                    ...(payload.title !== undefined ? { title: payload.title } : {}),
                    ...(payload.workspaceRoot !== undefined
                      ? { workspaceRoot: payload.workspaceRoot }
                      : {}),
                    ...(payload.defaultModelSelection !== undefined
                      ? { defaultModelSelection: payload.defaultModelSelection }
                      : {}),
                    ...(payload.scripts !== undefined ? { scripts: payload.scripts } : {}),
                    updatedAt: payload.updatedAt,
                  }
                : project,
            ),
          })),
        );

      case "project.deleted":
        return decodeForEvent(ProjectDeletedPayload, event.payload, event.type, "payload").pipe(
          Effect.map((payload) => ({
            ...nextBase,
            projects: nextBase.projects.map((project) =>
              project.id === payload.projectId
                ? {
                    ...project,
                    deletedAt: payload.deletedAt,
                    updatedAt: payload.deletedAt,
                  }
                : project,
            ),
          })),
        );

      case "thread.created":
        return Effect.gen(function* () {
          const payload = yield* decodeForEvent(
            ThreadCreatedPayload,
            event.payload,
            event.type,
            "payload",
          );
          const thread: OrchestrationThread = yield* decodeForEvent(
            OrchestrationThread,
            {
              id: payload.threadId,
              projectId: payload.projectId,
              title: payload.title,
              modelSelection: payload.modelSelection,
              runtimeMode: payload.runtimeMode,
              interactionMode: payload.interactionMode,
              branch: payload.branch,
              worktreePath: payload.worktreePath,
              latestTurn: null,
              createdAt: payload.createdAt,
              updatedAt: payload.updatedAt,
              archivedAt: null,
              deletedAt: null,
              messages: [],
              activities: [],
              checkpoints: [],
              session: null,
            },
            event.type,
            "thread",
          );
          const existing = nextBase.threads.find((entry) => entry.id === thread.id);
          return {
            ...nextBase,
            threads: existing
              ? nextBase.threads.map((entry) => (entry.id === thread.id ? thread : entry))
              : [...nextBase.threads, thread],
          };
        });

      case "thread.deleted":
        return decodeForEvent(ThreadDeletedPayload, event.payload, event.type, "payload").pipe(
          Effect.map((payload) => ({
            ...nextBase,
            threads: updateThread(nextBase.threads, payload.threadId, {
              deletedAt: payload.deletedAt,
              updatedAt: payload.deletedAt,
            }),
          })),
        );

      case "thread.archived":
        return decodeForEvent(ThreadArchivedPayload, event.payload, event.type, "payload").pipe(
          Effect.map((payload) => ({
            ...nextBase,
            threads: updateThread(nextBase.threads, payload.threadId, {
              archivedAt: payload.archivedAt,
              updatedAt: payload.updatedAt,
            }),
          })),
        );

      case "thread.unarchived":
        return decodeForEvent(ThreadUnarchivedPayload, event.payload, event.type, "payload").pipe(
          Effect.map((payload) => ({
            ...nextBase,
            threads: updateThread(nextBase.threads, payload.threadId, {
              archivedAt: null,
              updatedAt: payload.updatedAt,
            }),
          })),
        );

      case "thread.meta-updated":
        return decodeForEvent(ThreadMetaUpdatedPayload, event.payload, event.type, "payload").pipe(
          Effect.map((payload) => ({
            ...nextBase,
            threads: updateThread(nextBase.threads, payload.threadId, {
              ...(payload.title !== undefined ? { title: payload.title } : {}),
              ...(payload.modelSelection !== undefined
                ? { modelSelection: payload.modelSelection }
                : {}),
              ...(payload.branch !== undefined ? { branch: payload.branch } : {}),
              ...(payload.worktreePath !== undefined ? { worktreePath: payload.worktreePath } : {}),
              updatedAt: payload.updatedAt,
            }),
          })),
        );

      case "thread.runtime-mode-set":
        return decodeForEvent(
          ThreadRuntimeModeSetPayload,
          event.payload,
          event.type,
          "payload",
        ).pipe(
          Effect.map((payload) => ({
            ...nextBase,
            threads: updateThread(nextBase.threads, payload.threadId, {
              runtimeMode: payload.runtimeMode,
              updatedAt: payload.updatedAt,
            }),
          })),
        );

      case "thread.interaction-mode-set":
        return decodeForEvent(
          ThreadInteractionModeSetPayload,
          event.payload,
          event.type,
          "payload",
        ).pipe(
          Effect.map((payload) => ({
            ...nextBase,
            threads: updateThread(nextBase.threads, payload.threadId, {
              interactionMode: payload.interactionMode,
              updatedAt: payload.updatedAt,
            }),
          })),
        );

      case "thread.message-sent":
        return Effect.gen(function* () {
          const payload = yield* decodeForEvent(
            MessageSentPayloadSchema,
            event.payload,
            event.type,
            "payload",
          );
          const thread = nextBase.threads.find((entry) => entry.id === payload.threadId);
          if (!thread) {
            return nextBase;
          }

          const message: OrchestrationMessage = yield* decodeForEvent(
            OrchestrationMessage,
            {
              id: payload.messageId,
              role: payload.role,
              text: payload.text,
              ...(payload.attachments !== undefined ? { attachments: payload.attachments } : {}),
              turnId: payload.turnId,
              streaming: payload.streaming,
              createdAt: payload.createdAt,
              updatedAt: payload.updatedAt,
            },
            event.type,
            "message",
          );

          const existingMessage = thread.messages.find((entry) => entry.id === message.id);
          const messages = existingMessage
            ? thread.messages.map((entry) =>
                entry.id === message.id
                  ? {
                      ...entry,
                      text: message.streaming
                        ? `${entry.text}${message.text}`
                        : message.text.length > 0
                          ? message.text
                          : entry.text,
                      streaming: message.streaming,
                      updatedAt: message.updatedAt,
                      turnId: message.turnId,
                      ...(message.attachments !== undefined
                        ? { attachments: message.attachments }
                        : {}),
                    }
                  : entry,
              )
            : [...thread.messages, message];
          const cappedMessages = messages.slice(-MAX_THREAD_MESSAGES);
          const shouldFinalizeLatestTurnFromAssistantMessage =
            message.role === "assistant" && message.turnId !== null && !message.streaming;
          const latestTurn = shouldFinalizeLatestTurnFromAssistantMessage
            ? thread.latestTurn?.turnId === message.turnId || thread.latestTurn === null
              ? {
                  turnId: message.turnId,
                  state: latestTurnStateAfterAssistantCompletion(thread.latestTurn, message.turnId),
                  requestedAt:
                    thread.latestTurn?.turnId === message.turnId
                      ? thread.latestTurn.requestedAt
                      : message.createdAt,
                  startedAt:
                    thread.latestTurn?.turnId === message.turnId
                      ? (thread.latestTurn.startedAt ?? message.createdAt)
                      : message.createdAt,
                  completedAt:
                    thread.latestTurn?.turnId === message.turnId
                      ? (thread.latestTurn.completedAt ?? message.updatedAt)
                      : message.updatedAt,
                  assistantMessageId: message.id,
                  ...latestTurnSourceProposedPlanPatch(thread.latestTurn, message.turnId),
                }
              : thread.latestTurn
            : thread.latestTurn;

          return {
            ...nextBase,
            threads: updateThread(nextBase.threads, payload.threadId, {
              messages: cappedMessages,
              latestTurn,
              updatedAt: event.occurredAt,
            }),
          };
        });

      case "thread.session-set":
        return Effect.gen(function* () {
          const payload = yield* decodeForEvent(
            ThreadSessionSetPayload,
            event.payload,
            event.type,
            "payload",
          );
          const thread = nextBase.threads.find((entry) => entry.id === payload.threadId);
          if (!thread) {
            return nextBase;
          }

          const session: OrchestrationSession = yield* decodeForEvent(
            OrchestrationSession,
            payload.session,
            event.type,
            "session",
          );
          const latestTurnMatchesActiveTurn = thread.latestTurn?.turnId === session.activeTurnId;
          const pendingTurnStart = pendingTurnStartByThread.get(payload.threadId);
          const shouldProjectActiveTurn =
            session.activeTurnId !== null &&
            (session.status === "running" ||
              session.status === "interrupted" ||
              session.status === "error");
          const shouldSettlePreviousActiveTurn =
            session.activeTurnId === null &&
            thread.session?.activeTurnId !== null &&
            (session.status === "ready" ||
              session.status === "interrupted" ||
              session.status === "error");
          const shouldPreserveTerminalLatestTurn =
            latestTurnMatchesActiveTurn &&
            thread.latestTurn !== null &&
            (thread.latestTurn.state === "completed" ||
              (thread.latestTurn.state === "error" && session.status !== "interrupted") ||
              thread.checkpoints.some((checkpoint) => checkpoint.turnId === session.activeTurnId));
          const pendingSourceProposedPlan =
            (latestTurnMatchesActiveTurn ? thread.latestTurn?.sourceProposedPlan : undefined) ??
            (session.status === "running" ? pendingTurnStart?.sourceProposedPlan : undefined);
          const pendingRequestedAt =
            session.status === "running" && !latestTurnMatchesActiveTurn
              ? pendingTurnStart?.requestedAt
              : undefined;

          if (session.activeTurnId !== null && session.status === "running") {
            pendingTurnStartByThread.delete(payload.threadId);
          }

          const previousActiveTurnId = thread.session?.activeTurnId ?? null;

          const settledLatestTurn =
            shouldSettlePreviousActiveTurn && previousActiveTurnId !== null
              ? {
                  turnId: previousActiveTurnId,
                  state: latestTurnStateAfterSessionSettlement(session.status),
                  requestedAt:
                    thread.latestTurn?.turnId === previousActiveTurnId
                      ? thread.latestTurn.requestedAt
                      : (thread.latestTurn?.requestedAt ?? session.updatedAt),
                  startedAt:
                    thread.latestTurn?.turnId === previousActiveTurnId
                      ? (thread.latestTurn.startedAt ?? session.updatedAt)
                      : (thread.latestTurn?.startedAt ?? session.updatedAt),
                  completedAt:
                    thread.latestTurn?.turnId === previousActiveTurnId
                      ? (thread.latestTurn.completedAt ?? session.updatedAt)
                      : session.updatedAt,
                  assistantMessageId:
                    thread.latestTurn?.turnId === previousActiveTurnId
                      ? thread.latestTurn.assistantMessageId
                      : null,
                  ...(thread.latestTurn?.turnId === previousActiveTurnId &&
                  thread.latestTurn.sourceProposedPlan !== undefined
                    ? { sourceProposedPlan: thread.latestTurn.sourceProposedPlan }
                    : {}),
                }
              : thread.latestTurn;

          return {
            ...nextBase,
            threads: updateThread(nextBase.threads, payload.threadId, {
              session,
              latestTurn: shouldProjectActiveTurn
                ? shouldPreserveTerminalLatestTurn
                  ? thread.latestTurn
                  : {
                      turnId: session.activeTurnId,
                      state: sessionStatusToLatestTurnState(session.status),
                      requestedAt: latestTurnMatchesActiveTurn
                        ? thread.latestTurn.requestedAt
                        : (pendingRequestedAt ?? session.updatedAt),
                      startedAt: latestTurnMatchesActiveTurn
                        ? (thread.latestTurn.startedAt ?? session.updatedAt)
                        : (pendingRequestedAt ?? session.updatedAt),
                      completedAt:
                        session.status === "running"
                          ? null
                          : latestTurnMatchesActiveTurn
                            ? (thread.latestTurn.completedAt ?? session.updatedAt)
                            : session.updatedAt,
                      assistantMessageId: latestTurnMatchesActiveTurn
                        ? thread.latestTurn.assistantMessageId
                        : null,
                      ...(pendingSourceProposedPlan !== undefined
                        ? { sourceProposedPlan: pendingSourceProposedPlan }
                        : {}),
                    }
                : settledLatestTurn,
              updatedAt: event.occurredAt,
            }),
          };
        });

      case "thread.turn-start-requested":
        return Effect.gen(function* () {
          const payload = yield* decodeForEvent(
            ThreadTurnStartRequestedPayload,
            event.payload,
            event.type,
            "payload",
          );
          const thread = nextBase.threads.find((entry) => entry.id === payload.threadId);
          if (!thread) {
            return nextBase;
          }

          pendingTurnStartByThread.set(payload.threadId, {
            requestedAt: payload.createdAt,
            ...(payload.sourceProposedPlan !== undefined
              ? { sourceProposedPlan: payload.sourceProposedPlan }
              : {}),
          });

          const nextModel = {
            ...nextBase,
            threads: updateThread(nextBase.threads, payload.threadId, {
              updatedAt: event.occurredAt,
            }),
          };
          return nextModel;
        });

      case "thread.proposed-plan-upserted":
        return Effect.gen(function* () {
          const payload = yield* decodeForEvent(
            ThreadProposedPlanUpsertedPayload,
            event.payload,
            event.type,
            "payload",
          );
          const thread = nextBase.threads.find((entry) => entry.id === payload.threadId);
          if (!thread) {
            return nextBase;
          }

          const proposedPlans = [
            ...thread.proposedPlans.filter((entry) => entry.id !== payload.proposedPlan.id),
            payload.proposedPlan,
          ]
            .toSorted(
              (left, right) =>
                left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
            )
            .slice(-200);

          return {
            ...nextBase,
            threads: updateThread(nextBase.threads, payload.threadId, {
              proposedPlans,
              updatedAt: event.occurredAt,
            }),
          };
        });

      case "thread.turn-diff-completed":
        return Effect.gen(function* () {
          const payload = yield* decodeForEvent(
            ThreadTurnDiffCompletedPayload,
            event.payload,
            event.type,
            "payload",
          );
          const thread = nextBase.threads.find((entry) => entry.id === payload.threadId);
          if (!thread) {
            return nextBase;
          }

          const checkpoint = yield* decodeForEvent(
            OrchestrationCheckpointSummary,
            {
              turnId: payload.turnId,
              checkpointTurnCount: payload.checkpointTurnCount,
              checkpointRef: payload.checkpointRef,
              status: payload.status,
              files: payload.files,
              assistantMessageId: payload.assistantMessageId,
              completedAt: payload.completedAt,
            },
            event.type,
            "checkpoint",
          );

          // Do not let a placeholder (status "missing") overwrite a checkpoint
          // that has already been captured with a real git ref (status "ready").
          // ProviderRuntimeIngestion may fire multiple turn.diff.updated events
          // per turn; without this guard later placeholders would clobber the
          // real capture dispatched by CheckpointReactor.
          const existing = thread.checkpoints.find((entry) => entry.turnId === checkpoint.turnId);
          if (existing && existing.status !== "missing" && checkpoint.status === "missing") {
            return nextBase;
          }

          const checkpoints = [
            ...thread.checkpoints.filter((entry) => entry.turnId !== checkpoint.turnId),
            checkpoint,
          ]
            .toSorted((left, right) => left.checkpointTurnCount - right.checkpointTurnCount)
            .slice(-MAX_THREAD_CHECKPOINTS);

          return {
            ...nextBase,
            threads: updateThread(nextBase.threads, payload.threadId, {
              checkpoints,
              latestTurn: {
                turnId: payload.turnId,
                state: checkpointStatusToLatestTurnState(payload.status),
                requestedAt:
                  thread.latestTurn?.turnId === payload.turnId
                    ? thread.latestTurn.requestedAt
                    : payload.completedAt,
                startedAt:
                  thread.latestTurn?.turnId === payload.turnId
                    ? (thread.latestTurn.startedAt ?? payload.completedAt)
                    : payload.completedAt,
                completedAt: payload.completedAt,
                assistantMessageId: payload.assistantMessageId,
                ...latestTurnSourceProposedPlanPatch(thread.latestTurn, payload.turnId),
              },
              updatedAt: event.occurredAt,
            }),
          };
        });

      case "thread.reverted":
        return decodeForEvent(ThreadRevertedPayload, event.payload, event.type, "payload").pipe(
          Effect.map((payload) => {
            const thread = nextBase.threads.find((entry) => entry.id === payload.threadId);
            if (!thread) {
              return nextBase;
            }

            pendingTurnStartByThread.delete(payload.threadId);

            const checkpoints = thread.checkpoints
              .filter((entry) => entry.checkpointTurnCount <= payload.turnCount)
              .toSorted((left, right) => left.checkpointTurnCount - right.checkpointTurnCount)
              .slice(-MAX_THREAD_CHECKPOINTS);
            const retainedTurnIds = new Set(checkpoints.map((checkpoint) => checkpoint.turnId));
            const messages = retainThreadMessagesAfterRevert(
              thread.messages,
              retainedTurnIds,
              payload.turnCount,
            ).slice(-MAX_THREAD_MESSAGES);
            const proposedPlans = retainThreadProposedPlansAfterRevert(
              thread.proposedPlans,
              retainedTurnIds,
            ).slice(-200);
            const activities = retainThreadActivitiesAfterRevert(
              thread.activities,
              retainedTurnIds,
            );

            const latestCheckpoint = checkpoints.at(-1) ?? null;
            const retainedLatestTurnSnapshot = selectFallbackLatestTurnSnapshot(
              Array.from(latestTurnSnapshotsByThread.get(payload.threadId)?.values() ?? []).filter(
                (snapshot) => retainedTurnIds.has(snapshot.turnId),
              ),
            );
            const latestTurn =
              retainedLatestTurnSnapshot !== undefined
                ? cloneLatestTurn(retainedLatestTurnSnapshot)
                : latestCheckpoint === null
                  ? null
                  : {
                      turnId: latestCheckpoint.turnId,
                      state: checkpointStatusToLatestTurnState(latestCheckpoint.status),
                      requestedAt: latestCheckpoint.completedAt,
                      startedAt: latestCheckpoint.completedAt,
                      completedAt: latestCheckpoint.completedAt,
                      assistantMessageId: latestCheckpoint.assistantMessageId,
                    };

            retainLatestTurnSnapshotsAfterRevert(
              latestTurnSnapshotsByThread,
              payload.threadId,
              retainedTurnIds,
            );

            return {
              ...nextBase,
              threads: updateThread(nextBase.threads, payload.threadId, {
                checkpoints,
                messages,
                proposedPlans,
                activities,
                latestTurn,
                updatedAt: event.occurredAt,
              }),
            };
          }),
        );

      case "thread.activity-appended":
        return decodeForEvent(
          ThreadActivityAppendedPayload,
          event.payload,
          event.type,
          "payload",
        ).pipe(
          Effect.map((payload) => {
            const thread = nextBase.threads.find((entry) => entry.id === payload.threadId);
            if (!thread) {
              return nextBase;
            }

            const activities = [
              ...thread.activities.filter((entry) => entry.id !== payload.activity.id),
              payload.activity,
            ]
              .toSorted(compareThreadActivities)
              .slice(-500);

            return {
              ...nextBase,
              threads: updateThread(nextBase.threads, payload.threadId, {
                activities,
                updatedAt: event.occurredAt,
              }),
            };
          }),
        );

      default:
        return Effect.succeed(nextBase);
    }
  })();

  return projected.pipe(
    Effect.map((nextModel) => {
      pendingTurnStartMetadataByModel.set(nextModel, pendingTurnStartByThread);
      for (const thread of nextModel.threads) {
        recordLatestTurnSnapshot(latestTurnSnapshotsByThread, thread.id, thread.latestTurn);
      }
      latestTurnSnapshotsByModel.set(nextModel, latestTurnSnapshotsByThread);
      return nextModel;
    }),
  );
}
