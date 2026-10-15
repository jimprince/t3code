import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { ProjectId, ThreadId, ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";
import * as Option from "effect/Option";
import * as Layer from "effect/Layer";
import * as FileSystem from "effect/FileSystem";
import { expect } from "vite-plus/test";
import { layerMemory, layerFromPath } from "../persistence/Sqlite.ts";
import { layer as storeLayer, AutomationStore } from "../automations/AutomationStore.ts";
import { makeSubheadRegistry } from "./SubheadRegistry.ts";
import { makeSubheadRuns } from "./SubheadRuns.ts";

const template = {
  name: "review",
  projectId: ProjectId.make("project"),
  ownerThreadId: ThreadId.make("head"),
  description: "Reviews changes",
  prompt: "Review the request.",
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6.1-sol" },
  runtimeMode: "approval-required" as const,
  concurrency: 1,
};
const caller = {
  environmentId: "environment",
  principal: "script:fixture",
  threadId: null,
  runtimeMode: "full-access" as const,
};
const input = { name: "review", requestId: "retry", request: "Check this change" };
const database = storeLayer.pipe(Layer.provideMerge(layerMemory));

it.layer(NodeServices.layer)("subhead run admission", (it) => {
  it.effect(
    "reopens a real SQLite file and returns the original run and execution identities",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const folder = yield* fs.makeTempDirectoryScoped({ prefix: "subhead-restart-" });
        const persisted = storeLayer.pipe(
          Layer.provideMerge(layerFromPath(`${folder}/state.sqlite`)),
        );
        const first = yield* Effect.gen(function* () {
          const registry = yield* makeSubheadRegistry;
          yield* registry.create(template);
          yield* registry.setState("review", "enable");
          return yield* (yield* makeSubheadRuns).send(caller, input);
        }).pipe(Effect.provide(persisted));
        const retry = yield* Effect.gen(function* () {
          const service = yield* makeSubheadRuns;
          return yield* service.send(caller, input);
        }).pipe(Effect.provide(persisted));
        expect(retry).toEqual(first);
      }),
  );
  it.effect(
    "concurrent retries persist one frozen AutomationRun and conflicting text rejects",
    () =>
      Effect.gen(function* () {
        const registry = yield* makeSubheadRegistry;
        yield* registry.create(template);
        yield* registry.setState("review", "enable");
        const service = yield* makeSubheadRuns;
        const [a, b] = yield* Effect.all(
          [service.send(caller, input), service.send(caller, input)],
          { concurrency: "unbounded" },
        );
        expect(a.id).toBe(b.id);
        expect(a.steps[0]?.threadId).toBe(b.steps[0]?.threadId);
        expect(yield* (yield* AutomationStore).activeRuns).toHaveLength(1);
        yield* registry.edit("review", { ...template, prompt: "Changed" }, 1);
        const retry = yield* service.send(caller, input);
        expect(retry.virtualSubhead?.template.prompt).toBe(template.prompt);
        expect(
          yield* service.send(caller, { ...input, request: "Different" }).pipe(Effect.flip),
        ).toMatchObject({ message: expect.stringContaining("conflict") });
      }).pipe(Effect.provide(database)),
  );
  it.effect(
    "disabled helpers reject new sends, retries survive disabling, and run callers cannot recurse",
    () =>
      Effect.gen(function* () {
        const registry = yield* makeSubheadRegistry;
        yield* registry.create(template);
        const service = yield* makeSubheadRuns;
        expect(yield* service.send(caller, input).pipe(Effect.flip)).toMatchObject({
          message: expect.stringContaining("disabled"),
        });
        yield* registry.setState("review", "enable");
        const run = yield* service.send(caller, input);
        expect(
          yield* service
            .send(
              { ...caller, threadId: run.steps[0]!.threadId },
              { ...input, requestId: "recursive" },
            )
            .pipe(Effect.flip),
        ).toMatchObject({ message: expect.stringContaining("recursion") });
        yield* registry.setState("review", "disable");
        expect((yield* service.send(caller, input)).id).toBe(run.id);
        expect(
          yield* service.send(caller, { ...input, requestId: "new" }).pipe(Effect.flip),
        ).toMatchObject({ message: expect.stringContaining("disabled") });
      }).pipe(Effect.provide(database)),
  );
  it.effect(
    "enforces admission rate and caller permission ceilings without losing admitted rows",
    () =>
      Effect.gen(function* () {
        const registry = yield* makeSubheadRegistry;
        yield* registry.create({ ...template, runtimeMode: "full-access" });
        yield* registry.setState("review", "enable");
        const service = yield* makeSubheadRuns;
        expect(
          yield* service
            .send({ ...caller, runtimeMode: "approval-required" }, input)
            .pipe(Effect.flip),
        ).toMatchObject({ message: expect.stringContaining("permission") });
        for (let index = 0; index < 3; index++)
          yield* service.send(caller, { ...input, requestId: `rate-${index}` });
        expect(
          yield* service.send(caller, { ...input, requestId: "rate-4" }).pipe(Effect.flip),
        ).toMatchObject({ message: expect.stringContaining("rate") });
        expect(yield* (yield* AutomationStore).activeRuns).toHaveLength(3);
      }).pipe(Effect.provide(database)),
  );
  it.effect("bounds queued work at ten and daily admissions at twenty", () =>
    Effect.gen(function* () {
      const registry = yield* makeSubheadRegistry;
      yield* registry.create(template);
      yield* registry.setState("review", "enable");
      const service = yield* makeSubheadRuns;
      const store = yield* AutomationStore;
      const admitted = [];
      for (let index = 0; index < 10; index++)
        admitted.push(
          yield* service.send(
            { ...caller, principal: `sender-${index}` },
            { ...input, requestId: `queue-${index}` },
          ),
        );
      expect(
        yield* service.send({ ...caller, principal: "queue-overflow" }, input).pipe(Effect.flip),
      ).toMatchObject({ message: expect.stringContaining("queue") });
      for (const run of admitted)
        yield* store.saveRun({ ...run, status: "completed", finishedAt: run.createdAt });
      for (let index = 10; index < 20; index++) {
        const run = yield* service.send(
          { ...caller, principal: `sender-${index}` },
          { ...input, requestId: `daily-${index}` },
        );
        yield* store.saveRun({ ...run, status: "completed", finishedAt: run.createdAt });
        admitted.push(run);
      }
      expect(
        yield* service.send({ ...caller, principal: "daily-overflow" }, input).pipe(Effect.flip),
      ).toMatchObject({ message: expect.stringContaining("daily") });
      const persisted = yield* Effect.forEach(admitted, (run) => store.getRun(run.id));
      expect(persisted.every(Option.isSome)).toBe(true);
      expect(yield* store.listRuns({ limit: 100 })).toEqual([]);
      expect(
        yield* service
          .read({ ...caller, principal: "someone-else" }, admitted[0]!.id)
          .pipe(Effect.flip),
      ).toMatchObject({ message: expect.stringContaining("authenticated sender") });
    }).pipe(Effect.provide(database)),
  );
  it.effect(
    "lists every open run plus the newest finished runs per subhead, with no result text",
    () =>
      Effect.gen(function* () {
        const registry = yield* makeSubheadRegistry;
        for (const name of ["review", "audit"]) {
          yield* registry.create({ ...template, name });
          yield* registry.setState(name, "enable");
        }
        const service = yield* makeSubheadRuns;
        const store = yield* AutomationStore;
        // The run column that orders history is the admission time, so advance the test clock.
        const send = (name: string, requestId: string, request = "Check this change") =>
          TestClock.adjust("1 minute").pipe(
            Effect.andThen(
              service.send(
                { ...caller, principal: `sender-${requestId}`, threadId: null },
                { name, requestId, request },
              ),
            ),
          );
        const old = yield* send("review", "old");
        const recent = yield* send("review", "recent", `${"long request ".repeat(40)}end`);
        const open = yield* send("review", "open");
        const other = yield* send("audit", "other");
        yield* store.saveRun({
          ...old,
          status: "completed",
          result: "secret finding",
          finishedAt: old.createdAt,
        });
        yield* store.saveRun({
          ...recent,
          status: "failed",
          finishedAt: recent.createdAt,
          virtualSubhead: {
            ...recent.virtualSubhead!,
            terminationReason: "timeout 30m",
            delivery: { ...recent.virtualSubhead!.delivery, status: "undelivered" },
          },
        });
        yield* store.saveRun({ ...open, status: "running" });
        yield* store.saveRun({ ...other, status: "completed", finishedAt: other.createdAt });

        const rows = yield* service.list({ perSubhead: 1 });
        // Open run, the newest finished review run and the only audit run; the older review run
        // is outside the one-per-subhead window.
        expect(rows.map((row) => [row.subheadName, row.requestId, row.status])).toEqual(
          expect.arrayContaining([
            ["review", "open", "running"],
            ["review", "recent", "failed"],
            ["audit", "other", "completed"],
          ]),
        );
        expect(rows.some((row) => row.requestId === "old")).toBe(false);
        const failed = rows.find((row) => row.requestId === "recent")!;
        expect(failed).toMatchObject({
          templateVersion: 1,
          terminationReason: "timeout 30m",
          delivery: { status: "undelivered" },
          senderThreadId: null,
          threadId: recent.steps[0]!.threadId,
        });
        expect(failed.requestSummary.length).toBeLessThanOrEqual(200);
        expect(JSON.stringify(rows)).not.toContain("secret finding");
        expect(Object.keys(failed)).not.toContain("result");

        const onlyReview = yield* service.list({ name: "review", perSubhead: 5 });
        expect(new Set(onlyReview.map((row) => row.subheadName))).toEqual(new Set(["review"]));
        expect(onlyReview.map((row) => row.requestId)).toEqual(["open", "recent", "old"]);
        expect(
          yield* service.list({ name: "missing", perSubhead: 5 }).pipe(Effect.flip),
        ).toMatchObject({
          message: expect.stringContaining("No subhead"),
        });
        // Runs of other principals stay listable: this is operator visibility, not a result read.
        expect(onlyReview.map((row) => row.senderPrincipal)).toContain("sender-open");
      }).pipe(Effect.provide(database)),
  );
});
