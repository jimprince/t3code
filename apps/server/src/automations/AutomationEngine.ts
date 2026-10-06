import {
  AutomationError,
  MessageId,
  ThreadId,
  type Automation,
  type AutomationAgentTarget,
  type AutomationEventKind,
  type AutomationResultMode,
  type AutomationDefinition,
  type AutomationRun,
  type AutomationRunStep,
  type AutomationScript,
  type AutomationScriptDefinition,
  type ProjectAutomation,
  type ProjectId,
} from "@t3tools/contracts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
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
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { forkParked } from "../serverActivation.ts";
import { AgentGateway } from "./AgentGateway.ts";
import { AutomationStore } from "./AutomationStore.ts";
import { withResultMode } from "./resultModes.ts";
import {
  eventContext,
  eventsFor,
  stateKey,
  triggerMatches,
  type AutomationEvent,
  type AutomationObservation,
} from "./events.ts";
import { ReleaseFeed } from "./ReleaseFeed.ts";
import { automationTimeZone, latestScheduledRun, nextScheduledRun } from "./schedule.ts";

const MAX_AUTOMATIONS_PER_PROJECT = 100;
const MAX_UNFINISHED_RUNS = 20;
const MISSED_AFTER_MS = 86_400_000;
/** Issue labels and GitHub releases are polled; everything else is pushed. */
const POLL_INTERVAL_MS = 5 * 60_000;

const sameStep = (a: AutomationRunStep, b: AutomationRunStep | undefined) =>
  b !== undefined &&
  a.status === b.status &&
  a.result === b.result &&
  a.startedAt === b.startedAt &&
  a.finishedAt === b.finishedAt;

const isActive = (status: AutomationRun["status"]) => status === "queued" || status === "running";

type Fx<A> = Effect.Effect<A, AutomationError>;

/**
 * Owns scripts and automation rules: validates edits, fires schedule triggers once per slot,
 * advances agent steps through the gateway and keeps each run's log. Mutations and the worker
 * pass share one permit, so an edit never races a firing.
 */
export class AutomationEngine extends Context.Service<
  AutomationEngine,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    readonly drain: Effect.Effect<void>;
    /** Polls issue labels and releases now; the server also does this every five minutes. */
    readonly pollNow: Effect.Effect<void>;
    readonly list: (projectId?: ProjectId) => Fx<ReadonlyArray<Automation>>;
    readonly save: (definition: AutomationDefinition) => Fx<Automation>;
    readonly remove: (automationId: string) => Fx<void>;
    readonly setEnabled: (automationId: string, enabled: boolean) => Fx<Automation>;
    readonly run: (automationId: string, options?: { dryRun?: boolean }) => Fx<AutomationRun>;
    readonly runs: (input: {
      automationId?: string;
      projectId?: ProjectId;
      limit?: number;
    }) => Fx<ReadonlyArray<AutomationRun>>;
    readonly listScripts: (projectId: ProjectId | null) => Fx<ReadonlyArray<AutomationScript>>;
    readonly saveScript: (definition: AutomationScriptDefinition) => Fx<AutomationScript>;
    readonly removeScript: (scriptId: string) => Fx<void>;
    readonly runScript: (input: {
      projectId: ProjectId;
      script: string;
      target?: AutomationAgentTarget;
      ownerThreadId?: ThreadId;
      resultMode?: AutomationResultMode;
      dryRun?: boolean;
    }) => Fx<AutomationRun>;
  }
>()("t3/automations/AutomationEngine") {}

const fail = (message: string) => Effect.fail(new AutomationError({ message }));

function runTitle(name: string, at: string, timeZone: string) {
  const day = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(Date.parse(at));
  return `${name} · ${day}`;
}

/** Aggregate step progress: steps run in order and a failure stops the rest. */
function summarize(steps: ReadonlyArray<AutomationRunStep>): {
  status: AutomationRun["status"];
  result: string | null;
} {
  const failed = steps.find((step) => step.status === "failed");
  if (failed) return { status: "failed", result: failed.result };
  if (steps.every((step) => step.status === "completed" || step.status === "skipped"))
    return { status: "completed", result: steps.at(-1)?.result ?? null };
  return {
    status: steps.some((step) => step.status !== "queued") ? "running" : "queued",
    result: null,
  };
}

/** Converts a timed automation stored by the original fork scheduler, keeping its identity. */
function importLegacyAutomation(
  projectId: ProjectId,
  legacy: ProjectAutomation,
  now: string,
): { automation: Automation; runs: AutomationRun[] } {
  const prefix = `${projectId}:${legacy.id}:`;
  return {
    automation: {
      id: legacy.id,
      projectId,
      name: legacy.name,
      enabled: legacy.enabled,
      ...(legacy.ownerThreadId ? { ownerThreadId: legacy.ownerThreadId } : {}),
      triggers: [{ type: "schedule", schedule: legacy.schedule }],
      actions: [{ type: "agent", prompt: legacy.prompt, target: legacy.target }],
      nextRunAt: legacy.nextRunAt,
      createdAt: now,
      updatedAt: now,
    },
    runs: legacy.runs.map((run) => {
      const dedupeKey = run.id.startsWith(prefix) ? run.id.slice(prefix.length) : run.id;
      return {
        id: run.id,
        automationId: legacy.id,
        projectId,
        name: run.name,
        dedupeKey,
        trigger: Number.isNaN(Date.parse(dedupeKey))
          ? { kind: "manual" }
          : { kind: "schedule", scheduledAt: run.scheduledAt },
        ...(run.ownerThreadId ? { ownerThreadId: run.ownerThreadId } : {}),
        dryRun: false,
        status: run.status,
        result: run.result,
        steps: [
          {
            kind: "agent",
            status: run.status,
            target: run.target,
            threadId: run.threadId,
            messageId: run.messageId,
            title: runTitle(run.name, run.scheduledAt, legacy.schedule.timeZone),
            prompt: run.prompt,
            result: run.result,
            startedAt: run.startedAt,
            finishedAt: run.finishedAt,
          },
        ],
        createdAt: run.scheduledAt,
        finishedAt: run.finishedAt,
      };
    }),
  };
}

/** The project script a paused legacy automation becomes, or null when its name has no slug. */
function legacyScript(
  projectId: ProjectId,
  legacy: ProjectAutomation,
  now: string,
): AutomationScript | null {
  if (legacy.enabled) return null;
  const name = legacy.name
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[^a-z0-9]+|-+$/g, "")
    .slice(0, 80);
  if (name === "") return null;
  return {
    id: `legacy:${legacy.id}`,
    projectId,
    name,
    description: `From the paused automation "${legacy.name}".`,
    prompt: legacy.prompt,
    createdAt: now,
    updatedAt: now,
  };
}

const make = Effect.gen(function* () {
  const store = yield* AutomationStore;
  const gateway = yield* AgentGateway;
  const releases = yield* ReleaseFeed;
  const crypto = yield* Crypto.Crypto;
  const scope = yield* Scope.Scope;
  const permit = yield* Semaphore.make(1);
  const disabled = yield* Config.Boolean("T3CODE_DISABLE_STARTUP_RESUME").pipe(
    Config.withDefault(false),
  );
  const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));
  let watched: ReadonlySet<string> = new Set();
  /** Event kinds some enabled automation listens to; refreshed every pass. */
  let wanted: ReadonlySet<AutomationEventKind> = new Set();
  let timer: Fiber.Fiber<void> | undefined;
  let enqueue: () => Effect.Effect<void> = () => Effect.void;
  const locked = <A, E>(effect: Effect.Effect<A, E>) => permit.withPermits(1)(effect);

  /** Resolves each action's prompt now, so later script edits never change a recorded run. */
  const buildRun = Effect.fn("AutomationEngine.buildRun")(function* (input: {
    automationId: string;
    projectId: ProjectId;
    name: string;
    ownerThreadId?: ThreadId | undefined;
    dedupeKey: string;
    trigger: AutomationRun["trigger"];
    actions: AutomationDefinition["actions"];
    timeZone: string;
    now: string;
    dryRun: boolean;
    /** What fired the run, appended to every prompt. */
    context?: string;
  }) {
    const runId = `${input.projectId}:${input.automationId}:${input.dedupeKey}`;
    const at = input.trigger.kind === "schedule" ? input.trigger.scheduledAt : input.now;
    const steps: AutomationRunStep[] = [];
    for (const [index, action] of input.actions.entries()) {
      let prompt = action.prompt ?? "";
      let resultMode = action.resultMode;
      if (action.script !== undefined) {
        const script = yield* store.findScript(input.projectId, action.script);
        if (Option.isNone(script)) return yield* fail(`Script "${action.script}" does not exist.`);
        prompt = script.value.prompt;
        resultMode ??= script.value.resultMode ?? "review";
      }
      const id = `automation:${runId}${index === 0 ? "" : `:${index}`}`;
      steps.push({
        kind: "agent",
        status: input.dryRun ? "skipped" : "queued",
        target: action.target,
        threadId:
          action.target.kind === "existing-thread" ? action.target.threadId : ThreadId.make(id),
        messageId: MessageId.make(id),
        title: runTitle(input.name, at, input.timeZone),
        prompt: withResultMode(
          input.context ? `${prompt}\n\n${input.context}` : prompt,
          resultMode,
        ),
        ...(action.script !== undefined ? { script: action.script } : {}),
        ...(resultMode !== undefined ? { resultMode } : {}),
        result: input.dryRun ? "Dry run: not started." : null,
        startedAt: null,
        finishedAt: input.dryRun ? input.now : null,
      });
    }
    return {
      id: runId,
      automationId: input.automationId,
      projectId: input.projectId,
      name: input.name,
      dedupeKey: input.dedupeKey,
      trigger: input.trigger,
      ...(input.ownerThreadId ? { ownerThreadId: input.ownerThreadId } : {}),
      dryRun: input.dryRun,
      status: input.dryRun ? "completed" : "queued",
      result: input.dryRun
        ? `Dry run: would start ${steps.length} agent turn${steps.length === 1 ? "" : "s"}.`
        : null,
      steps,
      createdAt: input.now,
      finishedAt: input.dryRun ? input.now : null,
    } satisfies AutomationRun;
  });

  const unfinished = (automationId: string) =>
    store.activeRuns.pipe(
      Effect.map((runs) => runs.filter((run) => run.automationId === automationId).length),
    );

  /** Records one schedule slot as a run (or a skipped one) and advances the deadline. */
  const fire = Effect.fn("AutomationEngine.fire")(function* (automation: Automation, now: string) {
    const slot = automation.nextRunAt!;
    const scheduledAt = latestScheduledRun(automation.triggers, now) ?? slot;
    const missed = Date.parse(now) - Date.parse(scheduledAt) > MISSED_AFTER_MS;
    const full = (yield* unfinished(automation.id)) >= MAX_UNFINISHED_RUNS;
    const built = yield* buildRun({
      automationId: automation.id,
      projectId: automation.projectId,
      name: automation.name,
      ownerThreadId: automation.ownerThreadId,
      dedupeKey: slot,
      trigger: { kind: "schedule", scheduledAt },
      actions: automation.actions,
      timeZone: automationTimeZone(automation.triggers),
      now,
      dryRun: false,
    }).pipe(
      Effect.map((run): AutomationRun => {
        if (!missed && !full) return run;
        const result = full
          ? "Too many unfinished automation runs."
          : "Server missed this schedule by more than 24 hours.";
        return {
          ...run,
          status: "skipped",
          result,
          finishedAt: now,
          steps: run.steps.map((step) => ({ ...step, status: "skipped", finishedAt: now })),
        };
      }),
      Effect.catchTags({
        AutomationError: (error) =>
          Effect.succeed<AutomationRun>({
            id: `${automation.projectId}:${automation.id}:${slot}`,
            automationId: automation.id,
            projectId: automation.projectId,
            name: automation.name,
            dedupeKey: slot,
            trigger: { kind: "schedule", scheduledAt },
            dryRun: false,
            status: "failed",
            result: error.message,
            steps: [],
            createdAt: now,
            finishedAt: now,
          }),
      }),
    );
    yield* store.transaction(
      Effect.gen(function* () {
        yield* store.insertRun(built);
        yield* store.saveAutomation({
          ...automation,
          nextRunAt: nextScheduledRun(automation.triggers, now),
          updatedAt: now,
        });
      }),
    );
  });

  const advanceRun = Effect.fn("AutomationEngine.advanceRun")(function* (run: AutomationRun) {
    const steps = [...run.steps];
    for (const [index, step] of steps.entries()) {
      if (step.status === "completed" || step.status === "skipped") continue;
      if (step.status === "failed") break;
      const next = yield* gateway.advance(run, step).pipe(
        Effect.catchCauseIf(
          (cause) => !Cause.hasInterruptsOnly(cause),
          (cause) =>
            nowIso.pipe(
              Effect.map((now): AutomationRunStep => ({
                ...step,
                status: "failed",
                result: Cause.pretty(cause).slice(0, 1000),
                finishedAt: now,
              })),
            ),
        ),
      );
      steps[index] = next;
      if (next.status !== "completed") break;
    }
    const { status, result } = summarize(steps);
    if (status === "failed")
      for (const [index, step] of steps.entries())
        if (step.status === "queued") steps[index] = { ...step, status: "skipped" };
    if (status === run.status && steps.every((step, index) => sameStep(step, run.steps[index])))
      return;
    yield* store.saveRun({
      ...run,
      steps,
      status,
      result,
      finishedAt: isActive(status) ? null : yield* nowIso,
    });
  });

  /**
   * Copies records left by the original scheduler into the store. The originals stay on the
   * project untouched, so a rollback to a release with the old scheduler still has them. The
   * stored row (or its deleted tombstone) is the migration marker: nothing in this release reads
   * or fires the originals, and a copy is made at most once per id.
   */
  const importLegacy = Effect.fn("AutomationEngine.importLegacy")(function* (now: string) {
    for (const { projectId, automation } of yield* gateway.legacyAutomations) {
      const imported = importLegacyAutomation(projectId, automation, now);
      yield* store.transaction(
        Effect.gen(function* () {
          if (!(yield* store.insertAutomationOnce(imported.automation))) return;
          for (const run of imported.runs) yield* store.insertRun(run);
          // A paused timed automation was an on-demand procedure: offer it as a script too.
          const script = legacyScript(projectId, automation, now);
          if (
            script !== null &&
            !(yield* store.listScripts(projectId)).some(
              (entry) => entry.projectId === projectId && entry.name === script.name,
            )
          )
            yield* store.saveScript(script);
        }),
      );
    }
  });

  const pass = Effect.gen(function* () {
    if (timer !== undefined) {
      yield* Fiber.interrupt(timer);
      timer = undefined;
    }
    if (disabled) return;
    const now = yield* nowIso;
    yield* importLegacy(now);
    let nextDue = Infinity;
    const automations = yield* store.listAutomations();
    wanted = new Set(
      automations.flatMap((automation) =>
        automation.enabled
          ? automation.triggers.flatMap((trigger) =>
              trigger.type === "event" ? [trigger.event] : [],
            )
          : [],
      ),
    );
    for (const automation of automations) {
      if (!automation.enabled || automation.nextRunAt === null) continue;
      if (Date.parse(automation.nextRunAt) <= Date.parse(now)) yield* fire(automation, now);
      else nextDue = Math.min(nextDue, Date.parse(automation.nextRunAt));
    }
    const active = yield* store.activeRuns;
    watched = new Set(active.flatMap((run) => run.steps.map((step) => step.threadId)));
    for (const run of active) yield* advanceRun(run);
    if (Number.isFinite(nextDue))
      timer = yield* Effect.sleep(Math.max(1, nextDue - Date.parse(now))).pipe(
        Effect.andThen(Effect.suspend(enqueue)),
        Effect.forkIn(scope),
      );
  });

  /** Records one run for every enabled automation an event matches; the run key dedupes. */
  const ingest = Effect.fn("AutomationEngine.ingest")(function* (
    event: AutomationEvent,
    now: string,
  ) {
    let started = false;
    for (const automation of yield* store.listAutomations(event.projectId ?? undefined)) {
      if (
        !automation.enabled ||
        !automation.triggers.some((trigger) => triggerMatches(trigger, event))
      )
        continue;
      const full = (yield* unfinished(automation.id)) >= MAX_UNFINISHED_RUNS;
      const built = yield* buildRun({
        automationId: automation.id,
        projectId: automation.projectId,
        name: automation.name,
        ownerThreadId: automation.ownerThreadId,
        dedupeKey: `event:${event.kind}:${event.key}`,
        trigger: {
          kind: "event",
          event: event.kind,
          summary: event.summary,
          ...(event.url ? { url: event.url } : {}),
          occurredAt: event.occurredAt,
        },
        actions: automation.actions,
        timeZone: automationTimeZone(automation.triggers),
        now,
        dryRun: false,
        context: eventContext(event),
      }).pipe(
        Effect.map((run): AutomationRun =>
          full
            ? {
                ...run,
                status: "skipped",
                result: "Too many unfinished automation runs.",
                finishedAt: now,
                steps: run.steps.map((step) => ({ ...step, status: "skipped", finishedAt: now })),
              }
            : run,
        ),
      );
      if ((yield* store.insertRun(built)) && !full) started = true;
    }
    return started;
  });

  /** Compares an observation with the remembered state, records any runs, then remembers it. */
  const observe = (observation: AutomationObservation) =>
    locked(
      Effect.gen(function* () {
        const now = yield* nowIso;
        const key = stateKey(observation);
        const previous = key === null ? undefined : yield* store.getState(key);
        const { events, state } = eventsFor(observation, previous);
        return yield* store.transaction(
          Effect.gen(function* () {
            let started = false;
            for (const event of events) if (yield* ingest(event, now)) started = true;
            if (key !== null && state !== null && state !== previous)
              yield* store.setState(key, state, now);
            return started;
          }),
        );
      }),
    ).pipe(
      Effect.flatMap((started) => (started ? enqueue() : Effect.void)),
      Effect.catchCauseIf(
        (cause) => !Cause.hasInterruptsOnly(cause),
        (cause) => Effect.logWarning("automation event failed", { cause: Cause.pretty(cause) }),
      ),
    );

  const observer = yield* makeDrainableWorker(observe);

  /** Polls the sources that cannot push, only for what enabled automations listen to. */
  const poll = Effect.gen(function* () {
    if (disabled) return;
    const automations = (yield* store.listAutomations()).filter((automation) => automation.enabled);
    const listening = (kind: AutomationEventKind) =>
      automations.filter((automation) =>
        automation.triggers.some((trigger) => trigger.type === "event" && trigger.event === kind),
      );
    const roots = new Set(
      listening("issue.labeled").flatMap((automation) =>
        automation.ownerThreadId ? [automation.ownerThreadId] : [],
      ),
    );
    for (const root of roots)
      for (const observation of yield* gateway.projectIssueLabels(root))
        yield* observer.enqueue(observation);
    const repositories = new Set(
      listening("release.published").flatMap((automation) =>
        automation.triggers.flatMap((trigger) =>
          trigger.type === "event" &&
          trigger.event === "release.published" &&
          trigger.filter?.repository
            ? [trigger.filter.repository]
            : [],
        ),
      ),
    );
    for (const repository of repositories) {
      const release = yield* releases.latest(repository);
      if (Option.isSome(release))
        yield* observer.enqueue({
          type: "release",
          repository,
          tag: release.value.tag,
          url: release.value.url,
          at: release.value.publishedAt || (yield* nowIso),
        });
    }
  }).pipe(
    Effect.catchCause((cause) =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.interrupt
        : Effect.logWarning("automation poll failed", { cause: Cause.pretty(cause) }),
    ),
  );

  const worker = yield* makeDrainableWorker((_item: undefined) =>
    locked(pass).pipe(
      Effect.catchCauseIf(
        (cause) => !Cause.hasInterruptsOnly(cause),
        (cause) =>
          Effect.logWarning("automation engine pass failed", { cause: Cause.pretty(cause) }),
      ),
    ),
  );
  enqueue = () => worker.enqueue(undefined);

  const requireAutomation = (automationId: string) =>
    store.getAutomation(automationId).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () => fail("Automation does not exist."),
          onSome: Effect.succeed,
        }),
      ),
    );

  const validateDefinition = Effect.fn("AutomationEngine.validate")(function* (
    definition: AutomationDefinition,
  ) {
    if (!(yield* gateway.projectExists(definition.projectId)))
      return yield* fail("Project does not exist.");
    if (
      definition.ownerThreadId &&
      !(yield* gateway.threadInProject(definition.ownerThreadId, definition.projectId))
    )
      return yield* fail("Owner thread must belong to this project.");
    for (const trigger of definition.triggers) {
      if (trigger.type !== "event") continue;
      if (trigger.event === "issue.labeled" && !definition.ownerThreadId)
        return yield* fail(
          "Issue triggers need an owner thread: its project's repositories are watched.",
        );
      if (trigger.event === "release.published" && !trigger.filter?.repository)
        return yield* fail("Release triggers need a repository (owner/name).");
    }
    for (const action of definition.actions) {
      if (
        action.target.kind === "existing-thread" &&
        !(yield* gateway.threadInProject(action.target.threadId, definition.projectId))
      )
        return yield* fail("Target thread must belong to this project.");
      if (
        action.script !== undefined &&
        Option.isNone(yield* store.findScript(definition.projectId, action.script))
      )
        return yield* fail(`Script "${action.script}" does not exist.`);
    }
  });

  const save = (definition: AutomationDefinition) =>
    locked(
      Effect.gen(function* () {
        yield* validateDefinition(definition);
        const now = yield* nowIso;
        const existing = yield* store.getAutomation(definition.id);
        if (Option.isSome(existing) && existing.value.projectId !== definition.projectId)
          return yield* fail("An automation cannot move between projects.");
        if (
          Option.isNone(existing) &&
          (yield* store.listAutomations(definition.projectId)).length >= MAX_AUTOMATIONS_PER_PROJECT
        )
          return yield* fail("A project can have at most 100 automations.");
        const automation: Automation = {
          ...definition,
          nextRunAt: nextScheduledRun(definition.triggers, now),
          createdAt: Option.isSome(existing) ? existing.value.createdAt : now,
          updatedAt: now,
        };
        yield* store.saveAutomation(automation);
        return automation;
      }),
    ).pipe(Effect.tap(enqueue));

  const remove = (automationId: string) =>
    locked(
      Effect.gen(function* () {
        yield* requireAutomation(automationId);
        const now = yield* nowIso;
        yield* store.transaction(
          Effect.gen(function* () {
            yield* store.deleteAutomation(automationId, now);
            for (const run of yield* store.activeRuns)
              if (
                run.automationId === automationId &&
                run.steps.every((step) => step.status === "queued")
              )
                yield* store.saveRun({
                  ...run,
                  status: "skipped",
                  result: "Automation was removed.",
                  finishedAt: now,
                  steps: run.steps.map((step) => ({ ...step, status: "skipped" })),
                });
          }),
        );
      }),
    );

  const setEnabled = (automationId: string, enabled: boolean) =>
    locked(
      Effect.gen(function* () {
        const current = yield* requireAutomation(automationId);
        const now = yield* nowIso;
        const automation: Automation = {
          ...current,
          enabled,
          nextRunAt: enabled ? nextScheduledRun(current.triggers, now) : current.nextRunAt,
          updatedAt: now,
        };
        yield* store.saveAutomation(automation);
        return automation;
      }),
    ).pipe(Effect.tap(enqueue));

  const startRun = (run: AutomationRun) =>
    Effect.gen(function* () {
      if (!run.dryRun && (yield* unfinished(run.automationId)) >= MAX_UNFINISHED_RUNS)
        return yield* fail("Too many unfinished automation runs.");
      yield* store.insertRun(run);
      return run;
    });

  const run = (automationId: string, options: { dryRun?: boolean } = {}) =>
    locked(
      Effect.gen(function* () {
        const automation = yield* requireAutomation(automationId);
        const now = yield* nowIso;
        const dryRun = options.dryRun === true;
        const built = yield* buildRun({
          automationId,
          projectId: automation.projectId,
          name: automation.name,
          ownerThreadId: automation.ownerThreadId,
          dedupeKey: `${dryRun ? "dry-run" : "manual"}:${yield* Effect.orDie(crypto.randomUUIDv4)}`,
          trigger: { kind: "manual" },
          actions: automation.actions,
          timeZone: automationTimeZone(automation.triggers),
          now,
          dryRun,
        });
        return yield* startRun(built);
      }),
    ).pipe(Effect.tap(enqueue));

  const runs = (input: { automationId?: string; projectId?: ProjectId; limit?: number }) =>
    store.listRuns({ ...input, limit: input.limit ?? 20 });

  const saveScript = (definition: AutomationScriptDefinition) =>
    locked(
      Effect.gen(function* () {
        if (definition.projectId !== null && !(yield* gateway.projectExists(definition.projectId)))
          return yield* fail("Project does not exist.");
        const scope = yield* store.listScripts(definition.projectId);
        if (
          scope.some(
            (script) =>
              script.name === definition.name &&
              script.projectId === definition.projectId &&
              script.id !== definition.id,
          )
        )
          return yield* fail(`A script named "${definition.name}" already exists here.`);
        const existing = yield* store.getScript(definition.id);
        const now = yield* nowIso;
        const script: AutomationScript = {
          ...definition,
          createdAt: Option.isSome(existing) ? existing.value.createdAt : now,
          updatedAt: now,
        };
        yield* store.saveScript(script);
        return script;
      }),
    );

  const removeScript = (scriptId: string) =>
    locked(
      Effect.gen(function* () {
        const script = yield* store.getScript(scriptId);
        if (Option.isNone(script)) return yield* fail("Script does not exist.");
        const users = (yield* store.listAutomations(script.value.projectId ?? undefined)).filter(
          (automation) => automation.actions.some((action) => action.script === script.value.name),
        );
        if (users.length > 0)
          return yield* fail(
            `Script is used by ${users.map((automation) => `"${automation.name}"`).join(", ")}.`,
          );
        yield* store.deleteScript(scriptId);
      }),
    );

  const runScript = (input: {
    projectId: ProjectId;
    script: string;
    target?: AutomationAgentTarget;
    ownerThreadId?: ThreadId;
    resultMode?: AutomationResultMode;
    dryRun?: boolean;
  }) =>
    locked(
      Effect.gen(function* () {
        const target = input.target ?? { kind: "new-thread" };
        yield* validateDefinition({
          id: "script-run",
          projectId: input.projectId,
          name: input.script,
          enabled: true,
          ...(input.ownerThreadId ? { ownerThreadId: input.ownerThreadId } : {}),
          triggers: [],
          actions: [{ type: "agent", script: input.script, target }],
        });
        const script = Option.getOrThrow(yield* store.findScript(input.projectId, input.script));
        const now = yield* nowIso;
        const dryRun = input.dryRun === true;
        const built = yield* buildRun({
          automationId: `script:${script.id}`,
          projectId: input.projectId,
          name: script.name,
          ownerThreadId: input.ownerThreadId,
          dedupeKey: `${dryRun ? "dry-run" : "manual"}:${yield* Effect.orDie(crypto.randomUUIDv4)}`,
          trigger: { kind: "manual" },
          actions: [
            {
              type: "agent",
              script: input.script,
              target,
              ...(input.resultMode ? { resultMode: input.resultMode } : {}),
            },
          ],
          timeZone: automationTimeZone([]),
          now,
          dryRun,
        });
        return yield* startRun(built);
      }),
    ).pipe(Effect.tap(enqueue));

  const start = Effect.fn("AutomationEngine.start")(function* () {
    const wakeups = yield* gateway.wakeups(() => watched);
    const observations = yield* gateway.observations(() => wanted);
    yield* forkParked(
      Effect.gen(function* () {
        yield* worker.enqueue(undefined);
        yield* Stream.runForEach(wakeups, () => worker.enqueue(undefined));
      }),
    );
    yield* forkParked(
      Stream.runForEach(observations, (observation) =>
        disabled ? Effect.void : observer.enqueue(observation),
      ),
    );
    yield* forkParked(Effect.forever(Effect.sleep(POLL_INTERVAL_MS).pipe(Effect.andThen(poll))));
  });

  return AutomationEngine.of({
    start,
    pollNow: poll,
    drain: Effect.all([observer.drain, worker.drain], { discard: true }).pipe(
      Effect.andThen(worker.drain),
    ),
    list: (projectId) => store.listAutomations(projectId),
    save,
    remove,
    setEnabled,
    run,
    runs,
    listScripts: (projectId) => store.listScripts(projectId),
    saveScript,
    removeScript,
    runScript,
  });
});

export const layer = Layer.effect(AutomationEngine, make);
