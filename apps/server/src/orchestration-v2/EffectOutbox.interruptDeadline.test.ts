import { assert, it } from "@effect/vitest";
import { CommandId, ProviderThreadId, ProviderTurnId, RunId, ThreadId } from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";
import { runMigrations } from "../persistence/Migrations.ts";
import * as Outbox from "./EffectOutbox.ts";

const layer = Outbox.layer.pipe(
  Layer.provideMerge(NodeSqliteClient.layer({ filename: ":memory:" })),
);
const claim = { workerId: "deadline-test", leaseDurationMs: 60_000 };

it.effect("claims ACK+10 before the older Stop+20 safety net and excludes running fallbacks", () =>
  Effect.gen(function* () {
    yield* runMigrations();
    const outbox = yield* Outbox.EffectOutboxV2;
    const now = yield* DateTime.now;
    const request = {
      type: "provider-turn.interrupt-settle" as const,
      providerThreadId: ProviderThreadId.make("provider-thread:deadline"),
      providerTurnId: ProviderTurnId.make("provider-turn:deadline"),
    };
    const common = {
      commandId: CommandId.make("stop:deadline"),
      threadId: ThreadId.make("thread:deadline"),
      request,
    };
    yield* outbox.enqueue([
      { ...common, id: "stop+20", availableAt: DateTime.add(now, { seconds: 20 }) },
      { ...common, id: "ack+10", availableAt: DateTime.add(now, { seconds: 10 }) },
    ]);
    assert.equal(
      DateTime.toEpochMillis(Option.getOrThrow(yield* outbox.nextClaimableAt)),
      DateTime.toEpochMillis(now) + 10_000,
    );
    yield* TestClock.adjust("9999 millis");
    assert.isTrue(Option.isNone(yield* outbox.claimNext(claim)));
    yield* TestClock.adjust("1 millis");
    assert.equal(Option.getOrThrow(yield* outbox.claimNext(claim)).id, "ack+10");
    yield* TestClock.adjust("10 seconds");
    assert.isTrue(
      Option.isNone(yield* outbox.claimNext(claim)),
      "running ACK fallback excludes the older safety net",
    );
    assert.isTrue(yield* outbox.succeed({ effectId: "ack+10", workerId: claim.workerId }));
    assert.equal(Option.getOrThrow(yield* outbox.claimNext(claim)).id, "stop+20");
  }).pipe(Effect.provide(layer)),
);

it.effect("preserves lifecycle FIFO while an earlier effect waits for its retry deadline", () =>
  Effect.gen(function* () {
    yield* runMigrations();
    const outbox = yield* Outbox.EffectOutboxV2;
    const now = yield* DateTime.now;
    const runId = RunId.make("run:lifecycle-order");
    const common = {
      commandId: CommandId.make("start:lifecycle-order"),
      threadId: ThreadId.make("thread:lifecycle-order"),
    };
    yield* outbox.enqueue([
      {
        ...common,
        id: "earlier",
        request: { type: "provider-turn.start", runId },
        availableAt: DateTime.add(now, { seconds: 20 }),
      },
      {
        ...common,
        id: "later",
        request: { type: "provider-runtime.continue", sourceRunId: runId },
        availableAt: DateTime.add(now, { seconds: 10 }),
      },
    ]);
    yield* TestClock.adjust("10 seconds");
    assert.isTrue(
      Option.isNone(yield* outbox.claimNext(claim)),
      "a pending lifecycle retry still blocks later lifecycle work",
    );
    yield* TestClock.adjust("10 seconds");
    assert.equal(Option.getOrThrow(yield* outbox.claimNext(claim)).id, "earlier");
    assert.isTrue(yield* outbox.succeed({ effectId: "earlier", workerId: claim.workerId }));
    assert.equal(Option.getOrThrow(yield* outbox.claimNext(claim)).id, "later");
  }).pipe(Effect.provide(layer)),
);
