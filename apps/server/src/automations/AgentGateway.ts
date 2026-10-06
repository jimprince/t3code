import {
  CommandId,
  DEFAULT_MODEL_BY_PROVIDER,
  ProviderInstanceId,
  type AutomationEventKind,
  type AutomationRun,
  type AutomationRunStep,
  type ProjectId,
  type ProjectAutomation,
  type ThreadId,
  type OrchestrationV2DomainEvent,
  type ThreadPullRequestLink,
} from "@t3tools/contracts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Scope from "effect/Scope";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { makeNestingService } from "../forkThreads/NestingService.ts";
import * as Stream from "effect/Stream";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ApplicationEvents from "../persistence/Services/OrchestrationEventStore.ts";
import * as ServerSettings from "../serverSettings.ts";
import type { AutomationObservation } from "./events.ts";
import { unboundRunOutcome } from "./runOutcome.ts";

import * as ProjectIssuesService from "../projectIssues/ProjectIssuesService.ts";
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
  const threads = yield* ThreadManagement.ThreadManagementService;
  const launch = yield* ThreadLaunch.ThreadLaunchService;
  const sql = yield* SqlClient.SqlClient;
  const nesting = yield* makeNestingService(sql, threads.getThreadShell, threads.dispatch);
  const projects = yield* ProjectStore.ProjectStoreV2;
  const settingsService = yield* ServerSettings.ServerSettingsService;
  const applicationEvents = yield* ApplicationEvents.OrchestrationEventStore;
  const projectIssues = yield* ProjectIssuesService.make;
  const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));
  const readProjection = (threadId: ThreadId) =>
    threads
      .getThreadRecords(threadId, [
        "runs",
        "messages",
        "runtimeRequests",
        "providerSessions",
        "providerThreads",
      ])
      .pipe(Effect.orDie);
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
    const project = yield* projects.getShell(run.projectId).pipe(Effect.orDie);
    if (Option.isNone(project)) return finish("failed", "Project was deleted.");
    const shell = yield* threads.getThreadShell(step.threadId).pipe(Effect.orDie);
    if (shell?.projectId !== undefined && shell.projectId !== run.projectId)
      return finish("failed", "Target thread moved to another project.");
    if (shell?.archivedAt != null) return finish("failed", "Target thread is archived.");
    if (step.target.kind === "existing-thread" && shell === null)
      return finish("failed", "Target thread was deleted.");
    const projection = shell === null ? null : yield* readProjection(step.threadId);
    const message = projection?.messages.find(
      (message) => message.id === step.messageId && message.role === "user",
    );
    if (message) {
      const started: AutomationRunStep =
        step.status === "queued" ? { ...step, status: "running", startedAt: now } : step;
      // The root run for this exact input owns completion, never a tool or child terminal.
      const root = projection?.runs.find(
        (candidate) =>
          candidate.id === message.runId ||
          (candidate.userMessageId === step.messageId &&
            candidate.restartContinuationOfRunId == null),
      );
      const providerThread = projection?.providerThreads.find(
        (thread) => thread.id === root?.providerThreadId,
      );
      const session = projection?.providerSessions.find(
        (session) => session.id === providerThread?.providerSessionId,
      );
      const outcome = unboundRunOutcome({
        messageCreatedAt: DateTime.formatIso(message.createdAt),
        run: root
          ? { status: root.status, requestedAt: DateTime.formatIso(root.requestedAt) }
          : null,
        session: session
          ? {
              status: session.status,
              updatedAt: DateTime.formatIso(session.updatedAt),
              lastError: session.lastError,
            }
          : null,
      });
      if (outcome) return finish(outcome.status, outcome.result);
      if (!root && message.runId === null && shell?.historyOrigin === "v1_import") {
        const legacy = yield* threads
          .readImportedAutomationOutcome(step.threadId, step.messageId)
          .pipe(Effect.orDie);
        if (legacy) return finish(legacy.status, legacy.result);
        return finish("failed", "Interrupted by the upgrade. Run it again if needed.");
      }
      return started;
    }
    if (step.status === "running")
      return finish(
        "failed",
        shell?.historyOrigin === "v1_import"
          ? "Interrupted by the upgrade. Run it again if needed."
          : "Run message is unavailable.",
      );
    if (
      projection &&
      (projection.runs.some((candidate) =>
        ["queued", "preparing", "starting", "running", "waiting"].includes(candidate.status),
      ) ||
        projection.runtimeRequests.some((request) => request.status === "pending") ||
        projection.providerThreads.some(
          (thread) =>
            thread.status === "active" ||
            thread.codexNativeGoal?.status === "active" ||
            (thread.pendingBackgroundTasks?.length ?? 0) > 0,
        ))
    )
      return step;
    const settings = resolveProjectSettings(
      yield* settingsService.getSettings.pipe(Effect.orDie),
      run.projectId,
      project.value,
    ).settings;
    const owner = run.ownerThreadId
      ? yield* threads.getThreadShell(run.ownerThreadId).pipe(Effect.orDie)
      : null;
    const fallback = Object.entries(settings.providerInstances).find(
      ([, instance]) => instance.enabled,
    );
    const modelSelection =
      settings.defaultModelSelection ??
      owner?.modelSelection ??
      (fallback
        ? {
            instanceId: ProviderInstanceId.make(fallback[0]),
            model: DEFAULT_MODEL_BY_PROVIDER[fallback[1].driver] ?? "default",
          }
        : null);
    const commandId = CommandId.make(
      `automation:start:${step.messageId.replace(/^automation:/, "")}`,
    );
    if (step.target.kind === "new-thread") {
      if (modelSelection === null && shell === null)
        return finish(
          "failed",
          "Set a project or environment default model before creating automated threads.",
        );
      if (shell === null) {
        yield* threads
          .dispatch({
            type: "thread.create",
            commandId: CommandId.make(`${commandId}:claim`),
            threadId: step.threadId,
            projectId: run.projectId,
            title: step.title,
            modelSelection: modelSelection!,
            createdBy: "system",
            creationSource: "server",
            runtimeMode: settings.defaultRuntimeMode,
            interactionMode: "default",
            branch: null,
            worktreePath: null,
          })
          .pipe(Effect.orDie);
      }
      if (run.ownerThreadId != null) {
        yield* nesting
          .update({
            commandId: CommandId.make(`${commandId}:parent`),
            threadId: step.threadId,
            parentThreadId: run.ownerThreadId,
          })
          .pipe(Effect.orDie);
      }
      yield* launch
        .launch({
          commandId,
          threadId: step.threadId,
          projectId: run.projectId,
          title: step.title,
          generateTitle: false,
          reuseExistingThread: true,
          modelSelection: shell?.modelSelection ?? modelSelection!,
          createdBy: "system",
          creationSource: "server",
          runtimeMode: shell?.runtimeMode ?? settings.defaultRuntimeMode,
          interactionMode: shell?.interactionMode ?? "default",
          workspaceStrategy: { type: "root" },
          initialMessage: { messageId: step.messageId, text: step.prompt, attachments: [] },
        })
        .pipe(Effect.orDie);
    } else {
      yield* threads
        .dispatch({
          type: "message.dispatch",
          createdBy: "system",
          creationSource: "server",
          dispatchMode: { type: "queue_after_active" },
          commandId,
          threadId: step.threadId,
          messageId: step.messageId,
          text: step.prompt,
          attachments: [],
        })
        .pipe(Effect.orDie);
    }
    return { ...step, status: "running", startedAt: now } satisfies AutomationRunStep;
  });
  const projectExists = (projectId: ProjectId) =>
    projects.getShell(projectId).pipe(Effect.map(Option.isSome), Effect.orDie);
  const threadInProject = (threadId: ThreadId, projectId: ProjectId) =>
    threads.getThreadShell(threadId).pipe(
      Effect.map((thread) => thread !== null && thread.projectId === projectId),
      Effect.orDie,
    );
  const liveEvents = Effect.gen(function* () {
    const afterSequence = yield* applicationEvents.latestApplicationSequence.pipe(Effect.orDie);
    return applicationEvents.streamApplicationEvents({ afterSequence }).pipe(Stream.orDie);
  });
  const wakeups = (watched: () => ReadonlySet<string>) =>
    liveEvents.pipe(
      Effect.map((events) =>
        events.pipe(
          Stream.filter((stored) =>
            "event" in stored
              ? watched().has(stored.event.threadId)
              : stored.type === "project.deleted" || stored.type === "project.meta-updated",
          ),
          Stream.map((stored): AutomationWakeup =>
            "event" in stored ? "thread" : stored.type === "project.deleted" ? "project" : "legacy",
          ),
        ),
      ),
    );
  const observations = (wanted: () => ReadonlySet<AutomationEventKind>) =>
    liveEvents.pipe(
      Effect.map((events) => {
        // Initialize each watched PR thread from prior native PR events, never from a later snapshot.
        const linksByThread = new Map<ThreadId, ReadonlyArray<ThreadPullRequestLink>>();
        return events.pipe(
          Stream.mapEffect((stored) =>
            Effect.gen(function* () {
              const kinds = wanted();
              if (!("event" in stored)) return [];
              const event = stored.event;
              if (
                !(
                  ((kinds.has("pull-request.opened") || kinds.has("ci.failed")) &&
                    event.type === "thread.pull-request-synced") ||
                  (kinds.has("worker.blocked") &&
                    (event.type === "provider-session.updated" ||
                      event.type === "runtime-request.updated"))
                )
              ) {
                // A disabled listener does no reads; invalidate stale baselines so re-enabling
                // compares against native history rather than reporting an old link as new.
                if (event.type === "thread.pull-request-synced")
                  linksByThread.delete(event.threadId);
                return [];
              }
              const thread = yield* threads.getThreadShell(event.threadId).pipe(Effect.orDie);
              if (!thread) return [];
              let previous = linksByThread.get(event.threadId);
              if (event.type === "thread.pull-request-synced") {
                if (previous === undefined) {
                  const snapshots = yield* Effect.forEach(
                    ["thread.created", "thread.pull-request-synced"] as const,
                    (eventType) =>
                      applicationEvents
                        .readAgentEvents({
                          threadId: event.threadId,
                          throughSequence: stored.sequence - 1,
                          eventType,
                        })
                        .pipe(Stream.runLast, Effect.orDie),
                  );
                  const latest = snapshots
                    .flatMap((item) => (Option.isSome(item) ? [item.value] : []))
                    .toSorted((a, b) => b.sequence - a.sequence)[0];
                  previous =
                    latest &&
                    (latest.event.type === "thread.created" ||
                      latest.event.type === "thread.pull-request-synced")
                      ? (latest.event.payload.pullRequests ?? [])
                      : [];
                }
                linksByThread.set(event.threadId, event.payload.pullRequests ?? []);
              }
              return observationsForEvent(event, thread, kinds, previous);
            }),
          ),
          Stream.flatMap((items) => Stream.fromIterable(items)),
        );
      }),
    );
  const projectIssueLabels = (rootThreadId: ThreadId) =>
    Effect.gen(function* () {
      const root = yield* threads.getThreadShell(rootThreadId);
      if (root === null) return [];
      const listed = yield* projectIssues.list({ rootThreadId });
      const at = yield* nowIso;
      return listed.issues.map((issue): AutomationObservation => ({
        type: "issue-labels",
        projectId: root.projectId,
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
          Effect.as([] as ReadonlyArray<AutomationObservation>),
        ),
      ),
    );
  const legacyAutomations = projects.listShells().pipe(
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

/** Demand-driven native-to-neutral event mapping, shared by live subscriptions and tests. */
export function observationsForEvent(
  event: OrchestrationV2DomainEvent,
  thread: { readonly projectId: ProjectId; readonly id: ThreadId; readonly title: string },
  wanted: ReadonlySet<AutomationEventKind>,
  previousLinks: ReadonlyArray<ThreadPullRequestLink> = [],
): ReadonlyArray<AutomationObservation> {
  const base = {
    projectId: thread.projectId,
    threadId: thread.id,
    at: DateTime.formatIso(event.occurredAt),
  };
  if (
    event.type === "thread.pull-request-synced" &&
    (wanted.has("pull-request.opened") || wanted.has("ci.failed"))
  ) {
    return (event.payload.pullRequests ?? [])
      .filter((link) => link.source !== "stack-dismissed")
      .flatMap((link): AutomationObservation[] => {
        const previous = previousLinks.find(
          (item) =>
            item.repository === link.repository &&
            item.number === link.number &&
            item.host === link.host,
        );
        const common = {
          ...base,
          repository: link.repository,
          number: link.number,
          url: link.url,
          title: link.snapshot?.title ?? "",
        };
        return [
          ...(wanted.has("pull-request.opened") &&
          (!previous || previous.source === "stack-dismissed")
            ? [{ ...common, type: "pull-request-linked" as const }]
            : []),
          ...(wanted.has("ci.failed") &&
          link.snapshot != null &&
          link.snapshot.syncedAt !== previous?.snapshot?.syncedAt
            ? [
                {
                  ...common,
                  type: "pull-request-checks" as const,
                  checks: link.snapshot.checksState ?? null,
                },
              ]
            : []),
        ];
      });
  }
  if (
    wanted.has("worker.blocked") &&
    event.type === "runtime-request.updated" &&
    event.payload.status === "pending" &&
    event.payload.kind !== "dynamic_tool_call" &&
    event.payload.kind !== "auth_refresh"
  )
    return [
      {
        ...base,
        type: "thread-waiting",
        title: thread.title,
        reason: event.payload.kind === "user_input" ? "input" : "approval",
        requestId: event.payload.id,
      },
    ];
  if (wanted.has("worker.blocked") && event.type === "provider-session.updated")
    return [
      {
        ...base,
        type: "thread-session",
        title: thread.title,
        status: event.payload.status,
        error: event.payload.lastError,
      },
    ];
  return [];
}
export const layer = Layer.effect(AgentGateway, make);
