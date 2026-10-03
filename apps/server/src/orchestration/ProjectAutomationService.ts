import { threadHasQueuedTurnStart } from "./ThreadSettlementPolicy.ts";
import {
  DEFAULT_MODEL_BY_PROVIDER,
  ProviderInstanceId,
  CommandId,
  type OrchestrationProjectShell,
  type ProjectAutomation,
  type ProjectAutomationRun,
} from "@t3tools/contracts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import * as Cause from "effect/Cause";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as ServerSettings from "../serverSettings.ts";
import { forkParked } from "../serverActivation.ts";
import * as OrchestrationEngine from "./Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "./Services/ProjectionSnapshotQuery.ts";

export class ProjectAutomationService extends Context.Service<
  ProjectAutomationService,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    readonly drain: Effect.Effect<void>;
  }
>()("t3/orchestration/ProjectAutomationService") {}

const make = Effect.gen(function* () {
  const engine = yield* OrchestrationEngine.OrchestrationEngineService;
  const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const settingsService = yield* ServerSettings.ServerSettingsService;
  const crypto = yield* Crypto.Crypto;
  const scope = yield* Scope.Scope;
  const disabled = yield* Config.Boolean("T3CODE_DISABLE_STARTUP_RESUME").pipe(
    Config.withDefault(false),
  );
  let watchedThreadIds = new Set<string>();
  let timer: Fiber.Fiber<void> | undefined;
  let enqueue: () => Effect.Effect<void> = () => Effect.void;
  const update = (
    project: OrchestrationProjectShell,
    automation: ProjectAutomation,
    run: ProjectAutomationRun,
    status: ProjectAutomationRun["status"],
    result: string | null,
  ) =>
    Effect.gen(function* () {
      yield* engine.dispatch({
        type: "project.automation.run.update",
        commandId: CommandId.make(`automation:update:${yield* crypto.randomUUIDv4}`),
        projectId: project.id,
        automationId: automation.id,
        runId: run.id,
        status,
        result,
      });
    });
  const execute = Effect.fn("ProjectAutomationService.execute")(function* (
    project: OrchestrationProjectShell,
    automation: ProjectAutomation,
    run: ProjectAutomationRun,
  ) {
    const target = yield* snapshots.getThreadShellByIdIncludingArchived(run.threadId);
    if (Option.isSome(target) && target.value.projectId !== project.id) {
      yield* update(project, automation, run, "failed", "Target thread moved to another project.");
      return;
    }
    if (Option.isSome(target) && target.value.archivedAt !== null) {
      yield* update(project, automation, run, "failed", "Target thread is archived.");
      return;
    }
    if (run.target.kind === "existing-thread" && Option.isNone(target)) {
      yield* update(project, automation, run, "failed", "Target thread was deleted.");
      return;
    }
    // The stable message and command identities make restart after dispatch idempotent.
    const message = Option.isSome(target)
      ? yield* snapshots.getTurnStartMessage({ threadId: run.threadId, messageId: run.messageId })
      : Option.none();
    if (Option.isSome(message)) {
      if (run.status === "queued") yield* update(project, automation, run, "running", null);
      if (Option.isSome(target)) {
        const turn = target.value.latestTurn;
        if (turn?.turnId === message.value.message.turnId && turn.state !== "running") {
          yield* update(
            project,
            automation,
            run,
            turn.state === "completed" ? "completed" : "failed",
            turn.state === "completed" ? "Turn completed." : `Turn ${turn.state}.`,
          );
        } else if (
          message.value.message.turnId !== null &&
          turn?.turnId !== message.value.message.turnId
        ) {
          const context = yield* snapshots.getThreadCheckpointContext(run.threadId);
          const checkpoint = Option.isSome(context)
            ? context.value.checkpoints.find(
                (entry) => entry.turnId === message.value.message.turnId,
              )
            : undefined;
          if (checkpoint)
            yield* update(
              project,
              automation,
              run,
              checkpoint.status === "error" ? "failed" : "completed",
              checkpoint.status === "error" ? "Turn checkpoint failed." : "Turn completed.",
            );
        } else if (
          target.value.session?.status === "error" ||
          target.value.session?.status === "stopped"
        ) {
          yield* update(
            project,
            automation,
            run,
            "failed",
            target.value.session.lastError ?? "Provider session stopped before completion.",
          );
        }
      }
      return;
    }
    if (run.status === "running") {
      yield* update(project, automation, run, "failed", "Run message is unavailable.");
      return;
    }
    if (
      Option.isSome(target) &&
      (threadHasQueuedTurnStart(target.value, DateTime.formatIso(yield* DateTime.now)) ||
        target.value.session?.status === "running" ||
        target.value.session?.status === "starting" ||
        (target.value.session?.activeTurnId ?? null) !== null ||
        target.value.latestTurn?.state === "running" ||
        target.value.hasPendingApprovals ||
        target.value.hasPendingUserInput)
    )
      return;
    const settings = resolveProjectSettings(
      yield* settingsService.getSettings,
      project.id,
      project,
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
    if (Option.isNone(target) && modelSelection === null) {
      yield* update(
        project,
        automation,
        run,
        "failed",
        "Set a project or environment default model before creating automated threads.",
      );
      return;
    }
    const now = DateTime.formatIso(yield* DateTime.now);
    yield* engine.dispatch({
      type: "thread.turn.start",
      commandId: CommandId.make(`automation:start:${run.id}`),
      threadId: run.threadId,
      message: { messageId: run.messageId, role: "user", text: run.prompt, attachments: [] },
      runtimeMode: Option.isSome(target) ? target.value.runtimeMode : settings.defaultRuntimeMode,
      interactionMode: Option.isSome(target) ? target.value.interactionMode : "default",
      createdAt: now,
      ...(Option.isNone(target) && modelSelection !== null
        ? {
            bootstrap: {
              createThread: {
                projectId: project.id,
                title: `${run.name} · ${new Intl.DateTimeFormat("en-CA", { timeZone: automation.schedule.timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(Date.parse(run.scheduledAt))}`,
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
    yield* update(project, automation, run, "running", null);
  });
  const worker = yield* makeDrainableWorker((_item: undefined) =>
    Effect.gen(function* () {
      if (timer !== undefined) {
        yield* Fiber.interrupt(timer);
        timer = undefined;
      }
      if (disabled) return;
      const snapshot = yield* snapshots.getShellSnapshot();
      const now = DateTime.formatIso(yield* DateTime.now);
      let nextDue = Infinity;
      watchedThreadIds = new Set(
        snapshot.projects.flatMap((project) =>
          (project.automations ?? []).flatMap((automation) =>
            automation.runs
              .filter((run) => run.status === "queued" || run.status === "running")
              .map((run) => run.threadId),
          ),
        ),
      );
      for (const project of snapshot.projects) {
        for (const automation of project.automations ?? []) {
          if (automation.enabled) {
            if (Date.parse(automation.nextRunAt) <= Date.parse(now)) {
              yield* engine.dispatch({
                type: "project.automation.fire",
                commandId: CommandId.make(
                  `automation:fire:${project.id}:${automation.id}:${automation.nextRunAt}`,
                ),
                projectId: project.id,
                automationId: automation.id,
                scheduledAt: automation.nextRunAt,
              });
            } else nextDue = Math.min(nextDue, Date.parse(automation.nextRunAt));
          }
          for (const run of automation.runs.toReversed()) {
            if (run.status !== "queued" && run.status !== "running") continue;
            yield* execute(project, automation, run).pipe(
              Effect.catchCauseIf(
                (cause) => !Cause.hasInterruptsOnly(cause),
                (cause) =>
                  update(project, automation, run, "failed", Cause.pretty(cause).slice(0, 1000)),
              ),
            );
          }
        }
      }
      if (Number.isFinite(nextDue))
        timer = yield* Effect.sleep(Math.max(1, nextDue - Date.parse(now))).pipe(
          Effect.andThen(Effect.suspend(enqueue)),
          Effect.forkIn(scope),
        );
    }).pipe(
      Effect.catchCauseIf(
        (cause) => !Cause.hasInterruptsOnly(cause),
        (cause) =>
          Effect.logWarning("project automation scheduler failed", { cause: Cause.pretty(cause) }),
      ),
    ),
  );
  enqueue = () => worker.enqueue(undefined);
  const start = Effect.fn("ProjectAutomationService.start")(function* () {
    const events = yield* engine.subscribeDomainEvents;
    yield* forkParked(
      Effect.gen(function* () {
        yield* worker.enqueue(undefined);
        yield* Stream.runForEach(events, (event) =>
          (event.type === "project.meta-updated" && event.payload.automations !== undefined) ||
          event.type === "project.deleted" ||
          (event.aggregateKind === "thread" &&
            watchedThreadIds.has(event.aggregateId) &&
            [
              "thread.session-set",
              "thread.turn-diff-completed",
              "thread.archived",
              "thread.deleted",
              "thread.activity-appended",
            ].includes(event.type))
            ? worker.enqueue(undefined)
            : Effect.void,
        );
      }),
    );
  });
  return { start, drain: worker.drain };
});
export const layer = Layer.effect(ProjectAutomationService, make);
