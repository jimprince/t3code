import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import {
  MessageId,
  ProjectId,
  ThreadId,
  type AutomationDefinition,
  type AutomationRunStep,
  type ProjectAutomation,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";
import { expect } from "vite-plus/test";
import { layerMemory as SqlitePersistenceMemory } from "../persistence/Sqlite.ts";
import { AgentGateway } from "./AgentGateway.ts";
import { AutomationEngine, layer as engineLayer } from "./AutomationEngine.ts";
import { AutomationStore, layer as storeLayer } from "./AutomationStore.ts";
import type { AutomationObservation } from "./events.ts";
import { ReleaseFeed, type Release } from "./ReleaseFeed.ts";

// 2026-10-05 is a Monday.
const NOW = "2026-10-05T06:00:00.000Z";
const projectId = ProjectId.make("project");
const owner = ThreadId.make("caf05bbc-3d2b-45f2-9bed-23705b28a704");

const daily: AutomationDefinition = {
  id: "digest",
  projectId,
  name: "Digest",
  enabled: true,
  triggers: [{ type: "schedule", schedule: { kind: "daily", time: "07:00", timeZone: "UTC" } }],
  actions: [{ type: "agent", prompt: "Summarize changes", target: { kind: "new-thread" } }],
};

function harness(
  options: {
    legacy?: Array<{ projectId: ProjectId; automation: ProjectAutomation }>;
    advance?: (step: AutomationRunStep) => AutomationRunStep;
  } = {},
) {
  return Effect.gen(function* () {
    const legacy = [...(options.legacy ?? [])];
    const advanced: AutomationRunStep[] = [];
    const passes = yield* Queue.unbounded<void>();
    const observations = yield* Queue.unbounded<AutomationObservation>();
    const issues = new Map<string, AutomationObservation[]>();
    const latestReleases = new Map<string, Release>();
    const gateway = Layer.mock(AgentGateway)({
      projectExists: () => Effect.succeed(true),
      threadInProject: () => Effect.succeed(true),
      advance: (_run, step) =>
        Effect.sync(() => {
          advanced.push(step);
          return options.advance?.(step) ?? { ...step, status: "running", startedAt: NOW };
        }),
      wakeups: () => Effect.succeed(Stream.never),
      observations: () => Effect.succeed(Stream.fromQueue(observations)),
      projectIssueLabels: (root) => Effect.sync(() => issues.get(root) ?? []),
      legacyAutomations: Queue.offer(passes, undefined).pipe(Effect.as([...legacy])),
    });
    return {
      layer: engineLayer.pipe(
        Layer.provideMerge(
          Layer.mergeAll(
            storeLayer,
            gateway,
            Layer.mock(ReleaseFeed)({
              latest: (repository) =>
                Effect.sync(() => Option.fromNullishOr(latestReleases.get(repository))),
            }),
          ),
        ),
        Layer.provide(SqlitePersistenceMemory),
      ),
      advanced,
      issues,
      latestReleases,
      /** Pushes an orchestration observation; a firing one is awaited with `settle`. */
      push: (observation: AutomationObservation) => Queue.offer(observations, observation),
      /** Waits for one complete engine pass. */
      settle: Effect.gen(function* () {
        yield* Queue.take(passes);
        yield* (yield* AutomationEngine).drain;
        yield* Queue.clear(passes);
      }),
    };
  });
}

it.layer(NodeServices.layer)("automation engine", (it) => {
  it.effect("fires a daily slot at its time and advances the deadline", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(NOW));
        const h = yield* harness();
        yield* Effect.gen(function* () {
          const engine = yield* AutomationEngine;
          yield* engine.save(daily);
          yield* engine.start();
          yield* h.settle;
          expect(yield* engine.runs({ automationId: daily.id })).toEqual([]);
          yield* TestClock.adjust("1 hour");
          yield* h.settle;
          const [run] = yield* engine.runs({ automationId: daily.id });
          const runId = "project:digest:2026-10-05T07:00:00.000Z";
          expect(run?.id).toBe(runId);
          expect(run?.status).toBe("running");
          expect(run?.steps[0]).toMatchObject({
            threadId: `automation:${runId}`,
            messageId: `automation:${runId}`,
            title: "Digest · 2026-10-05",
            prompt: "Summarize changes",
          });
          expect(h.advanced).toHaveLength(1);
          const [saved] = yield* engine.list(projectId);
          expect(saved?.nextRunAt).toBe("2026-10-06T07:00:00.000Z");
        }).pipe(Effect.provide(h.layer));
      }),
    ),
  );

  it.effect("records one run per slot even when the slot is seen again", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(NOW));
        const h = yield* harness();
        yield* Effect.gen(function* () {
          const engine = yield* AutomationEngine;
          const store = yield* AutomationStore;
          const saved = yield* engine.save(daily);
          const slot = "2026-10-05T05:00:00.000Z";
          const due = { ...saved, nextRunAt: slot };
          yield* store.saveAutomation(due);
          yield* engine.start();
          yield* h.settle;
          // A second sighting of the same slot (lost deadline write, restart) is a no-op.
          yield* store.saveAutomation(due);
          yield* engine.save({ ...daily, id: "other", enabled: false });
          yield* h.settle;
          const runs = yield* engine.runs({ automationId: daily.id });
          expect(runs.map((run) => run.dedupeKey)).toEqual([slot]);
        }).pipe(Effect.provide(h.layer));
      }),
    ),
  );

  it.effect("collapses downtime to the latest slot and skips one more than a day late", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(NOW));
        const h = yield* harness();
        yield* Effect.gen(function* () {
          const engine = yield* AutomationEngine;
          const store = yield* AutomationStore;
          const hourly = yield* engine.save({
            ...daily,
            id: "hourly",
            triggers: [{ type: "schedule", schedule: { kind: "hourly", timeZone: "UTC" } }],
          });
          yield* store.saveAutomation({ ...hourly, nextRunAt: "2026-10-02T07:00:00.000Z" });
          const weekly = yield* engine.save({
            ...daily,
            id: "weekly",
            triggers: [
              {
                type: "schedule",
                schedule: { kind: "weekly", day: 1, time: "07:00", timeZone: "UTC" },
              },
            ],
          });
          yield* store.saveAutomation({ ...weekly, nextRunAt: "2026-09-28T07:00:00.000Z" });
          yield* engine.start();
          yield* h.settle;
          const hourlyRuns = yield* engine.runs({ automationId: "hourly" });
          expect(hourlyRuns).toHaveLength(1);
          expect(hourlyRuns[0]?.trigger).toEqual({ kind: "schedule", scheduledAt: NOW });
          const [skipped] = yield* engine.runs({ automationId: "weekly" });
          expect(skipped?.status).toBe("skipped");
          expect(skipped?.result).toContain("more than 24 hours");
          expect(new Set(h.advanced.map((step) => step.threadId))).toEqual(
            new Set([hourlyRuns[0]?.steps[0]?.threadId]),
          );
        }).pipe(Effect.provide(h.layer));
      }),
    ),
  );

  it.effect(
    "copies legacy timed automations once, keeping ids, deadlines, live runs and originals",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          yield* TestClock.setTime(Date.parse(NOW));
          // Brad's two live automations on the t3code-fork project.
          const projectId = ProjectId.make("a50f5bdb-01be-4dea-8359-6959ac86a277");
          const legacyRecord = (id: string, name: string, time: string, nextRunAt: string) =>
            ({
              id,
              ownerThreadId: owner,
              name,
              schedule: { kind: "daily", time, timeZone: "America/Edmonton" },
              prompt: `${name} prompt`,
              target: { kind: "new-thread" },
              enabled: true,
              nextRunAt,
              runs: [],
            }) satisfies ProjectAutomation;
          const efficiency = legacyRecord(
            "97719f22-7b9f-46c2-83e2-0468ac7c1da9",
            "Nightly fork-efficiency review",
            "03:00",
            "2026-10-05T09:00:00.000Z",
          );
          const health: ProjectAutomation = {
            ...legacyRecord("health", "Fork-health refresh", "03:30", "2026-10-05T09:30:00.000Z"),
            runs: [
              {
                id: `${projectId}:health:2026-10-04T09:30:00.000Z`,
                name: "Fork-health refresh",
                target: { kind: "new-thread" },
                ownerThreadId: owner,
                scheduledAt: "2026-10-04T09:30:00.000Z",
                startedAt: "2026-10-04T09:30:01.000Z",
                finishedAt: null,
                threadId: ThreadId.make(`automation:${projectId}:health:2026-10-04T09:30:00.000Z`),
                messageId: MessageId.make(
                  `automation:${projectId}:health:2026-10-04T09:30:00.000Z`,
                ),
                prompt: "Fork-health refresh prompt",
                status: "running",
                result: null,
              },
            ],
          };
          const originals = [
            { projectId, automation: efficiency },
            { projectId, automation: health },
          ];
          const snapshot = structuredClone(originals);
          const h = yield* harness({ legacy: originals });
          yield* Effect.gen(function* () {
            const engine = yield* AutomationEngine;
            yield* engine.start();
            yield* h.settle;
            const imported = yield* engine.list(projectId);
            expect(imported.map((automation) => [automation.id, automation.nextRunAt])).toEqual([
              [efficiency.id, "2026-10-05T09:00:00.000Z"],
              ["health", "2026-10-05T09:30:00.000Z"],
            ]);
            expect(imported[0]).toMatchObject({
              ownerThreadId: owner,
              triggers: [{ type: "schedule", schedule: efficiency.schedule }],
              actions: [
                { type: "agent", prompt: efficiency.prompt, target: { kind: "new-thread" } },
              ],
            });
            // The in-flight run keeps its thread, so its turn is still tracked to completion.
            const [live] = yield* engine.runs({ automationId: "health" });
            expect(live?.dedupeKey).toBe("2026-10-04T09:30:00.000Z");
            expect(h.advanced.map((step) => step.threadId)).toEqual([health.runs[0]?.threadId]);

            // Every pass sees the originals again: the import is idempotent, and an automation
            // removed after import stays removed although its original is still on the project.
            yield* engine.save({ ...daily, projectId, enabled: false });
            yield* h.settle;
            expect(
              new Set((yield* engine.list(projectId)).map((automation) => automation.id)),
            ).toEqual(new Set([efficiency.id, "health", daily.id]));
            expect(yield* engine.runs({ automationId: "health" })).toHaveLength(1);
            yield* engine.remove("health");
            yield* engine.setEnabled(daily.id, false);
            yield* h.settle;
            expect(
              new Set((yield* engine.list(projectId)).map((automation) => automation.id)),
            ).toEqual(new Set([efficiency.id, daily.id]));

            yield* TestClock.adjust("3 hours");
            yield* h.settle;
            const [nightly] = yield* engine.runs({ automationId: efficiency.id });
            expect(nightly?.id).toBe(`${projectId}:${efficiency.id}:2026-10-05T09:00:00.000Z`);
            expect(nightly?.steps[0]?.title).toBe("Nightly fork-efficiency review · 2026-10-05");
            expect(nightly?.ownerThreadId).toBe(owner);
            expect(
              (yield* engine.list(projectId)).find((entry) => entry.id === efficiency.id)
                ?.nextRunAt,
            ).toBe("2026-10-06T09:00:00.000Z");
            // The originals were never changed, so a rollback finds them exactly as they were.
            expect(originals).toEqual(snapshot);
          }).pipe(Effect.provide(h.layer));
        }),
      ),
  );

  it.effect("resolves scripts when a run starts, preferring the project's own", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(NOW));
        const h = yield* harness();
        yield* Effect.gen(function* () {
          const engine = yield* AutomationEngine;
          yield* engine.saveScript({ id: "g", projectId: null, name: "review", prompt: "global" });
          yield* engine.saveScript({ id: "p", projectId, name: "review", prompt: "project" });
          yield* engine.save({
            ...daily,
            actions: [{ type: "agent", script: "review", target: { kind: "new-thread" } }],
          });
          const run = yield* engine.run(daily.id);
          expect(run.steps[0]?.script).toBe("review");
          expect(run.steps[0]?.prompt).toMatch(/^project\n\n---\nResult mode: review/);
          const blocked = yield* engine.removeScript("p").pipe(Effect.flip);
          expect(blocked.message).toContain('"Digest"');
          const missing = yield* engine
            .save({
              ...daily,
              id: "x",
              actions: [{ type: "agent", script: "nope", target: { kind: "new-thread" } }],
            })
            .pipe(Effect.flip);
          expect(missing.message).toContain('"nope"');
          const adHoc = yield* engine.runScript({ projectId, script: "review" });
          expect(adHoc.automationId).toBe("script:p");
          expect(Option.isSome(yield* (yield* AutomationStore).getScript("g"))).toBe(true);
        }).pipe(Effect.provide(h.layer));
      }),
    ),
  );

  it.effect("spells out a script's result mode in its prompt, overridable per run", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(NOW));
        const h = yield* harness();
        yield* Effect.gen(function* () {
          const engine = yield* AutomationEngine;
          yield* engine.saveScript({ id: "s", projectId, name: "audit", prompt: "Audit it." });
          const review = yield* engine.runScript({ projectId, script: "audit" });
          expect(review.steps[0]?.resultMode).toBe("review");
          expect(review.steps[0]?.prompt).toMatch(
            /^Audit it\.\n\n---\nResult mode: review\nFile nothing/,
          );
          const settle = yield* engine.runScript({
            projectId,
            script: "audit",
            resultMode: "file-and-settle",
          });
          expect(settle.steps[0]?.prompt).toContain("t3-thread request add");
          expect(settle.steps[0]?.prompt).toContain('t3-thread settle "$T3_THREAD_ID" --self');
          // act adds no filing or settling instructions: just the marker, for a run that should
          // do its job directly.
          const acting = yield* engine.runScript({
            projectId,
            script: "audit",
            resultMode: "act",
          });
          expect(acting.steps[0]?.resultMode).toBe("act");
          expect(acting.steps[0]?.prompt).toBe("Audit it.\n\n---\nResult mode: act\n");
          // Inline prompts (every imported timed automation) are sent exactly as written.
          yield* engine.save(daily);
          const inline = yield* engine.run(daily.id);
          expect(inline.steps[0]?.prompt).toBe("Summarize changes");
          expect(inline.steps[0]?.resultMode).toBeUndefined();
        }).pipe(Effect.provide(h.layer));
      }),
    ),
  );

  it.effect(
    "ships the global starter library and turns paused timed automations into scripts",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          yield* TestClock.setTime(Date.parse(NOW));
          const onDemand = (id: string, name: string, enabled: boolean): ProjectAutomation => ({
            id,
            name,
            prompt: `${name} prompt`,
            schedule: { kind: "weekly", day: 0, time: "06:00", timeZone: "America/Edmonton" },
            target: { kind: "new-thread" },
            enabled,
            nextRunAt: "2026-10-11T12:00:00.000Z",
            runs: [],
          });
          const h = yield* harness({
            legacy: [
              { projectId, automation: onDemand("2a135c02", "Review outstanding issues", false) },
              { projectId, automation: onDemand("937a61cd", "Review workspaces", false) },
              { projectId, automation: onDemand("492fe5b1", "Fork health refresh", true) },
            ],
          });
          yield* Effect.gen(function* () {
            const engine = yield* AutomationEngine;
            const starters = yield* engine.listScripts(null);
            expect(starters.map((script) => script.name).sort()).toEqual([
              "code-quality",
              "data-model-review",
              "dead-code",
              "dependencies",
              "docs-currency",
              "performance",
              "refactoring",
              "ux-review",
            ]);
            expect(starters.every((script) => script.resultMode === "review")).toBe(true);
            yield* engine.start();
            yield* h.settle;
            const project = (yield* engine.listScripts(projectId)).filter(
              (script) => script.projectId === projectId,
            );
            expect(project.map((script) => [script.name, script.prompt])).toEqual([
              ["review-outstanding-issues", "Review outstanding issues prompt"],
              ["review-workspaces", "Review workspaces prompt"],
            ]);
            // The paused automations themselves are still there, still paused.
            const paused = (yield* engine.list(projectId)).filter((entry) => !entry.enabled);
            expect(paused.map((entry) => entry.id).sort()).toEqual(["2a135c02", "937a61cd"]);
            const run = yield* engine.runScript({ projectId, script: "review-workspaces" });
            expect(run.steps[0]?.prompt).toContain("Result mode: review");
          }).pipe(Effect.provide(h.layer));
        }),
      ),
  );

  it.effect("records a dry run without starting anything", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(NOW));
        const h = yield* harness();
        yield* Effect.gen(function* () {
          const engine = yield* AutomationEngine;
          yield* engine.save(daily);
          yield* engine.start();
          yield* h.settle;
          const run = yield* engine.run(daily.id, { dryRun: true });
          yield* h.settle;
          expect(run).toMatchObject({ dryRun: true, status: "completed" });
          expect(run.steps.map((step) => step.status)).toEqual(["skipped"]);
          expect(h.advanced).toEqual([]);
        }).pipe(Effect.provide(h.layer));
      }),
    ),
  );

  it.effect("runs actions in order and stops at a failure", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(NOW));
        const h = yield* harness({
          advance: (step) => ({
            ...step,
            status: "failed",
            result: "Turn error.",
            finishedAt: NOW,
          }),
        });
        yield* Effect.gen(function* () {
          const engine = yield* AutomationEngine;
          yield* engine.save({
            ...daily,
            actions: [daily.actions[0]!, { ...daily.actions[0]!, prompt: "Second" }],
          });
          yield* engine.start();
          yield* h.settle;
          yield* engine.run(daily.id);
          yield* h.settle;
          const [run] = yield* engine.runs({ automationId: daily.id });
          expect(run?.status).toBe("failed");
          expect(run?.steps.map((step) => step.status)).toEqual(["failed", "skipped"]);
          expect(h.advanced).toHaveLength(1);
        }).pipe(Effect.provide(h.layer));
      }),
    ),
  );

  const onEvent = (
    id: string,
    trigger: Extract<AutomationDefinition["triggers"][number], { type: "event" }>,
    extra: Partial<AutomationDefinition> = {},
  ): AutomationDefinition => ({
    ...daily,
    id,
    name: id,
    triggers: [trigger],
    ...extra,
  });
  const pr = { projectId, threadId: ThreadId.make("worker"), repository: "brad/t3code-fork" };

  it.effect("fires on a pull request's checks turning failing, once per failing episode", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(NOW));
        const h = yield* harness();
        yield* Effect.gen(function* () {
          const engine = yield* AutomationEngine;
          yield* engine.save(
            onEvent("ci", {
              type: "event",
              event: "ci.failed",
              filter: { repository: pr.repository },
            }),
          );
          yield* engine.start();
          yield* h.settle;
          const checks = (
            checksState: "passing" | "failing" | "pending",
            at: string,
            repository = pr.repository,
          ): AutomationObservation => ({
            ...pr,
            repository,
            type: "pull-request-checks",
            number: 7,
            url: `https://git.example/${repository}/pulls/7`,
            title: "Fix sync",
            checks: checksState,
            at,
          });
          yield* h.push(checks("pending", "2026-10-05T06:01:00.000Z"));
          yield* h.push(checks("failing", "2026-10-05T06:02:00.000Z", "other/repo"));
          yield* h.push(checks("failing", "2026-10-05T06:03:00.000Z"));
          yield* h.settle;
          const [first] = yield* engine.runs({ automationId: "ci" });
          expect(first?.trigger).toMatchObject({
            kind: "event",
            event: "ci.failed",
            summary: 'Checks are failing on pull request brad/t3code-fork#7 "Fix sync".',
          });
          expect(first?.steps[0]?.prompt).toContain(
            "Summarize changes\n\n---\nTriggered by: Checks are failing",
          );
          expect(first?.steps[0]?.prompt).toContain(
            "Link: https://git.example/brad/t3code-fork/pulls/7",
          );
          // Still failing (another sync of the same run) does not fire; failing again after a
          // pass does.
          yield* h.push(checks("failing", "2026-10-05T06:04:00.000Z"));
          yield* h.push(checks("passing", "2026-10-05T06:05:00.000Z"));
          yield* h.push(checks("failing", "2026-10-05T06:06:00.000Z"));
          yield* h.settle;
          const runs = yield* engine.runs({ automationId: "ci" });
          expect(runs.map((run) => run.dedupeKey)).toEqual([
            "event:ci.failed:brad/t3code-fork#7:2026-10-05T06:06:00.000Z",
            "event:ci.failed:brad/t3code-fork#7:2026-10-05T06:03:00.000Z",
          ]);
        }).pipe(Effect.provide(h.layer));
      }),
    ),
  );

  it.effect("fires once per linked pull request and per blocked worker state", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(NOW));
        const h = yield* harness();
        yield* Effect.gen(function* () {
          const engine = yield* AutomationEngine;
          yield* engine.save(onEvent("opened", { type: "event", event: "pull-request.opened" }));
          yield* engine.save(onEvent("blocked", { type: "event", event: "worker.blocked" }));
          yield* engine.start();
          yield* h.settle;
          const linked: AutomationObservation = {
            ...pr,
            type: "pull-request-linked",
            number: 9,
            url: "https://git.example/pulls/9",
            title: null,
            at: NOW,
          };
          yield* h.push(linked);
          yield* h.settle;
          yield* h.push({ ...linked, at: "2026-10-05T06:10:00.000Z" });
          const session = (status: string, at: string): AutomationObservation => ({
            ...pr,
            type: "thread-session",
            title: "Worker",
            status,
            error: status === "error" ? "Provider crashed" : null,
            at,
          });
          yield* h.push({
            ...pr,
            type: "thread-waiting",
            title: "Worker",
            reason: "approval",
            requestId: "activity-1",
            at: NOW,
          });
          yield* h.settle;
          yield* h.push(session("error", "2026-10-05T06:11:00.000Z"));
          yield* h.settle;
          yield* h.push(session("error", "2026-10-05T06:12:00.000Z"));
          yield* h.push(session("ready", "2026-10-05T06:13:00.000Z"));
          yield* h.push(session("error", "2026-10-05T06:14:00.000Z"));
          yield* h.settle;
          expect(yield* engine.runs({ automationId: "opened" })).toHaveLength(1);
          const blocked = yield* engine.runs({ automationId: "blocked" });
          expect(blocked.map((run) => run.trigger.kind === "event" && run.trigger.summary)).toEqual(
            [
              'Thread "Worker" stopped with an error: Provider crashed',
              'Thread "Worker" stopped with an error: Provider crashed',
              'Thread "Worker" is waiting for an approval.',
            ],
          );
        }).pipe(Effect.provide(h.layer));
      }),
    ),
  );

  it.effect("polls issue labels from a baseline and fires only on newly added labels", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(NOW));
        const h = yield* harness();
        yield* Effect.gen(function* () {
          const engine = yield* AutomationEngine;
          yield* engine.save(
            onEvent(
              "triage",
              { type: "event", event: "issue.labeled", filter: { label: "bug" } },
              { ownerThreadId: owner },
            ),
          );
          const issue = (number: number, labels: string[]): AutomationObservation => ({
            type: "issue-labels",
            projectId,
            repository: "brad/t3code-fork",
            number,
            url: `https://git.example/issues/${number}`,
            title: `Issue ${number}`,
            labels,
            at: NOW,
          });
          const poll = (issues: AutomationObservation[]) =>
            Effect.gen(function* () {
              h.issues.set(owner, issues);
              yield* engine.pollNow;
              yield* engine.drain;
            });
          // Labels present before anyone watched are the baseline.
          yield* poll([issue(1, ["bug"]), issue(2, [])]);
          yield* poll([issue(1, ["bug", "docs"]), issue(2, ["bug"])]);
          yield* poll([issue(1, ["bug", "docs"]), issue(2, ["bug"])]);
          const runs = yield* engine.runs({ automationId: "triage" });
          expect(runs.map((run) => run.trigger.kind === "event" && run.trigger.summary)).toEqual([
            'Issue brad/t3code-fork#2 "Issue 2" was labeled bug.',
          ]);
          const unowned = yield* engine
            .save(onEvent("x", { type: "event", event: "issue.labeled" }))
            .pipe(Effect.flip);
          expect(unowned.message).toContain("owner thread");
        }).pipe(Effect.provide(h.layer));
      }),
    ),
  );

  it.effect("fires every project's release automation once per new release", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(NOW));
        const h = yield* harness();
        yield* Effect.gen(function* () {
          const engine = yield* AutomationEngine;
          const upstream = {
            type: "event" as const,
            event: "release.published" as const,
            filter: { repository: "pingdotgg/t3code" },
          };
          yield* engine.save(onEvent("here", upstream));
          yield* engine.save(onEvent("there", upstream, { projectId: ProjectId.make("other") }));
          const poll = (tag: string) =>
            Effect.gen(function* () {
              h.latestReleases.set("pingdotgg/t3code", {
                tag,
                url: `https://github.com/pingdotgg/t3code/releases/tag/${tag}`,
                publishedAt: NOW,
              });
              yield* engine.pollNow;
              yield* engine.drain;
            });
          yield* poll("v0.0.46-nightly.20261004");
          yield* poll("v0.0.46-nightly.20261005");
          yield* poll("v0.0.46-nightly.20261005");
          for (const id of ["here", "there"])
            expect((yield* engine.runs({ automationId: id })).map((run) => run.dedupeKey)).toEqual([
              "event:release.published:pingdotgg/t3code:v0.0.46-nightly.20261005",
            ]);
          const unnamed = yield* engine
            .save(onEvent("y", { type: "event", event: "release.published" }))
            .pipe(Effect.flip);
          expect(unnamed.message).toContain("repository");
        }).pipe(Effect.provide(h.layer));
      }),
    ),
  );
});
