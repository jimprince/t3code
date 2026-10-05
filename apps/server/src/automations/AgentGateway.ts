import {
  CommandId,
  DEFAULT_MODEL_BY_PROVIDER,
  ProviderInstanceId,
  type AutomationEventKind,
  type AutomationRun,
  type AutomationRunStep,
  type ProjectAutomation,
  type ProjectId,
  type ThreadId,
} from "@t3tools/contracts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { threadHasQueuedTurnStart } from "../orchestration/ThreadSettlementPolicy.ts";
import * as OrchestrationEngine from "../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ProjectIssuesService from "../projectIssues/ProjectIssuesService.ts";
import type { AutomationObservation } from "./events.ts";

/** Why the engine should look again. */
export type AutomationWakeup = "thread" | "legacy" | "project";

/**
 * Everything the automation engine needs from the orchestration core, in one place. The engine
 * and its tables know nothing about V1 commands, events or projections; porting to another core
 * rewrites this file.
 */
export class AgentGateway extends Context.Service<
  AgentGateway,
  {
    readonly projectExists: (projectId: ProjectId) => Effect.Effect<boolean>;
    readonly threadInProject: (threadId: ThreadId, projectId: ProjectId) => Effect.Effect<boolean>;
    /**
     * Moves one agent step forward: dispatches its turn once the target is free, then reads the
     * turn's outcome. Stable thread, message and command ids make a restart after dispatch safe.
     */
    readonly advance: (
      run: AutomationRun,
      step: AutomationRunStep,
    ) => Effect.Effect<AutomationRunStep>;
    /** Orchestration changes that may move a watched run or legacy record. */
    readonly wakeups: (
      watched: () => ReadonlySet<string>,
    ) => Effect.Effect<Stream.Stream<AutomationWakeup>, never, Scope.Scope>;
    /**
     * Thread, pull-request and session changes for the event kinds `wanted` returns, as neutral
     * observations. Nothing is read for kinds no enabled automation listens to.
     */
    readonly observations: (
      wanted: () => ReadonlySet<AutomationEventKind>,
    ) => Effect.Effect<Stream.Stream<AutomationObservation>, never, Scope.Scope>;
    /** Labels of every issue in the repositories of the project an orchestrator thread leads. */
    readonly projectIssueLabels: (
      rootThreadId: ThreadId,
    ) => Effect.Effect<ReadonlyArray<AutomationObservation>>;
    /** Timed automations stored on projects by the original fork scheduler; read only. */
    readonly legacyAutomations: Effect.Effect<
      ReadonlyArray<{ readonly projectId: ProjectId; readonly automation: ProjectAutomation }>
    >;
  }
>()("t3/automations/AgentGateway") {}

const make = Effect.gen(function* () {
  const engine = yield* OrchestrationEngine.OrchestrationEngineService;
  const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const settingsService = yield* ServerSettings.ServerSettingsService;
  const projectIssues = yield* ProjectIssuesService.make;

  const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));

  const advance = Effect.fn("AgentGateway.advance")(function* (
    run: AutomationRun,
    step: AutomationRunStep,
  ) {
    const now = yield* nowIso;
    const finish = (status: "completed" | "failed", result: string): AutomationRunStep => ({
      ...step,
      status,
      result,
      startedAt: step.startedAt ?? now,
      finishedAt: now,
    });
    const project = yield* snapshots.getProjectShellById(run.projectId);
    if (Option.isNone(project)) return finish("failed", "Project was deleted.");
    const target = yield* snapshots.getThreadShellByIdIncludingArchived(step.threadId);
    if (Option.isSome(target) && target.value.projectId !== run.projectId)
      return finish("failed", "Target thread moved to another project.");
    if (Option.isSome(target) && target.value.archivedAt !== null)
      return finish("failed", "Target thread is archived.");
    if (step.target.kind === "existing-thread" && Option.isNone(target))
      return finish("failed", "Target thread was deleted.");
    const message = Option.isSome(target)
      ? yield* snapshots.getTurnStartMessage({ threadId: step.threadId, messageId: step.messageId })
      : Option.none();
    if (Option.isSome(message)) {
      const started: AutomationRunStep =
        step.status === "queued" ? { ...step, status: "running", startedAt: now } : step;
      if (Option.isNone(target)) return started;
      const turnId = message.value.message.turnId;
      const turn = target.value.latestTurn;
      if (turn?.turnId === turnId && turn.state !== "running")
        return turn.state === "completed"
          ? finish("completed", "Turn completed.")
          : finish("failed", `Turn ${turn.state}.`);
      if (turnId !== null && turn?.turnId !== turnId) {
        const context = yield* snapshots.getThreadCheckpointContext(step.threadId);
        const checkpoint = Option.isSome(context)
          ? context.value.checkpoints.find((entry) => entry.turnId === turnId)
          : undefined;
        if (checkpoint)
          return checkpoint.status === "error"
            ? finish("failed", "Turn checkpoint failed.")
            : finish("completed", "Turn completed.");
        return started;
      }
      if (target.value.session?.status === "error" || target.value.session?.status === "stopped")
        return finish(
          "failed",
          target.value.session.lastError ?? "Provider session stopped before completion.",
        );
      return started;
    }
    if (step.status === "running") return finish("failed", "Run message is unavailable.");
    if (
      Option.isSome(target) &&
      (threadHasQueuedTurnStart(target.value, now) ||
        target.value.session?.status === "running" ||
        target.value.session?.status === "starting" ||
        (target.value.session?.activeTurnId ?? null) !== null ||
        target.value.latestTurn?.state === "running" ||
        target.value.hasPendingApprovals ||
        target.value.hasPendingUserInput)
    )
      return step;
    const settings = resolveProjectSettings(
      yield* settingsService.getSettings,
      run.projectId,
      project.value,
    ).settings;
    const owner = run.ownerThreadId
      ? yield* snapshots.getThreadShellByIdIncludingArchived(run.ownerThreadId)
      : Option.none();
    const fallback = Object.entries(settings.providerInstances).find(
      ([, instance]) => instance.enabled,
    );
    const modelSelection =
      settings.defaultModelSelection ??
      (Option.isSome(owner)
        ? owner.value.modelSelection
        : fallback
          ? {
              instanceId: ProviderInstanceId.make(fallback[0]),
              model: DEFAULT_MODEL_BY_PROVIDER[fallback[1].driver] ?? "default",
            }
          : null);
    if (Option.isNone(target) && modelSelection === null)
      return finish(
        "failed",
        "Set a project or environment default model before creating automated threads.",
      );
    yield* engine.dispatch({
      type: "thread.turn.start",
      commandId: CommandId.make(`automation:start:${step.messageId.replace(/^automation:/, "")}`),
      threadId: step.threadId,
      message: { messageId: step.messageId, role: "user", text: step.prompt, attachments: [] },
      runtimeMode: Option.isSome(target) ? target.value.runtimeMode : settings.defaultRuntimeMode,
      interactionMode: Option.isSome(target) ? target.value.interactionMode : "default",
      createdAt: now,
      ...(Option.isNone(target) && modelSelection !== null
        ? {
            bootstrap: {
              createThread: {
                projectId: run.projectId,
                title: step.title,
                lockTitle: true,
                modelSelection,
                runtimeMode: settings.defaultRuntimeMode,
                interactionMode: "default",
                branch: null,
                worktreePath: null,
                createdAt: now,
                parentThreadId: run.ownerThreadId ?? null,
              },
            },
          }
        : {}),
    });
    return { ...step, status: "running", startedAt: now } satisfies AutomationRunStep;
  }, Effect.orDie);

  const projectExists = (projectId: ProjectId) =>
    snapshots.getProjectShellById(projectId).pipe(Effect.map(Option.isSome), Effect.orDie);

  const threadInProject = (threadId: ThreadId, projectId: ProjectId) =>
    snapshots.getThreadShellByIdIncludingArchived(threadId).pipe(
      Effect.map((thread) => Option.isSome(thread) && thread.value.projectId === projectId),
      Effect.orDie,
    );

  const wakeups = (watched: () => ReadonlySet<string>) =>
    engine.subscribeDomainEvents.pipe(
      Effect.map((events) =>
        events.pipe(
          Stream.map((event): AutomationWakeup | null => {
            if (event.type === "project.meta-updated" && event.payload.automations !== undefined)
              return "legacy";
            if (event.type === "project.deleted") return "project";
            if (
              event.aggregateKind === "thread" &&
              watched().has(event.aggregateId) &&
              [
                "thread.session-set",
                "thread.turn-diff-completed",
                "thread.archived",
                "thread.deleted",
                "thread.activity-appended",
              ].includes(event.type)
            )
              return "thread";
            return null;
          }),
          Stream.filter((reason): reason is AutomationWakeup => reason !== null),
        ),
      ),
    );

  const observations = (wanted: () => ReadonlySet<AutomationEventKind>) =>
    engine.subscribeDomainEvents.pipe(
      Effect.map((events) =>
        events.pipe(
          Stream.mapEffect((event): Effect.Effect<ReadonlyArray<AutomationObservation>> =>
            Effect.gen(function* () {
              const kinds = wanted();
              if (event.aggregateKind !== "thread" || kinds.size === 0) return [];
              const relevant =
                (event.type === "thread.pull-request-linked" && kinds.has("pull-request.opened")) ||
                (event.type === "thread.pull-request-synced" && kinds.has("ci.failed")) ||
                (kinds.has("worker.blocked") &&
                  (event.type === "thread.session-set" ||
                    (event.type === "thread.activity-appended" &&
                      (event.payload.activity.kind === "approval.requested" ||
                        event.payload.activity.kind === "user-input.requested"))));
              if (!relevant) return [];
              const thread = yield* snapshots
                .getThreadShellByIdIncludingArchived(event.payload.threadId)
                .pipe(Effect.orElseSucceed(() => Option.none()));
              if (Option.isNone(thread)) return [];
              const base = {
                projectId: thread.value.projectId,
                threadId: thread.value.id,
                at: event.occurredAt,
              };
              switch (event.type) {
                case "thread.pull-request-linked":
                  return [
                    {
                      ...base,
                      type: "pull-request-linked",
                      repository: event.payload.link.repository,
                      number: event.payload.link.number,
                      url: event.payload.link.url,
                      title: event.payload.link.snapshot?.title ?? null,
                    },
                  ];
                case "thread.pull-request-synced":
                  return [
                    {
                      ...base,
                      type: "pull-request-checks",
                      repository: event.payload.repository,
                      number: event.payload.number,
                      url: event.payload.url ?? "",
                      title: event.payload.snapshot.title,
                      checks: event.payload.snapshot.checksState ?? null,
                    },
                  ];
                case "thread.activity-appended":
                  return [
                    {
                      ...base,
                      type: "thread-waiting",
                      title: thread.value.title,
                      reason:
                        event.payload.activity.kind === "approval.requested" ? "approval" : "input",
                      requestId: event.payload.activity.id,
                    },
                  ];
                case "thread.session-set":
                  return [
                    {
                      ...base,
                      type: "thread-session",
                      title: thread.value.title,
                      status: event.payload.session.status,
                      error: event.payload.session.lastError,
                    },
                  ];
                default:
                  return [];
              }
            }),
          ),
          Stream.flatMap((items) => Stream.fromIterable(items)),
        ),
      ),
    );

  const projectIssueLabels = (rootThreadId: ThreadId) =>
    Effect.gen(function* () {
      const root = yield* snapshots.getThreadShellByIdIncludingArchived(rootThreadId);
      if (Option.isNone(root)) return [];
      const listed = yield* projectIssues.list({ rootThreadId });
      const at = DateTime.formatIso(yield* DateTime.now);
      return listed.issues.map((issue): AutomationObservation => ({
        type: "issue-labels",
        projectId: root.value.projectId,
        repository: issue.repository,
        number: issue.number,
        url: issue.url,
        title: issue.title,
        labels: issue.labels,
        at,
      }));
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("automation issue poll failed", { rootThreadId, cause }).pipe(
          Effect.as([]),
        ),
      ),
    );

  const legacyAutomations = snapshots.getProjectShells().pipe(
    Effect.map((projects) =>
      projects.flatMap((project) =>
        (project.automations ?? []).map((automation) => ({ projectId: project.id, automation })),
      ),
    ),
    Effect.orDie,
  );

  return AgentGateway.of({
    projectExists,
    threadInProject,
    advance,
    wakeups,
    observations,
    projectIssueLabels,
    legacyAutomations,
  });
});

export const layer = Layer.effect(AgentGateway, make);
