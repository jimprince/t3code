import { assert, it } from "@effect/vitest";
import {
  MessageId,
  ProviderInstanceId,
  ProviderDriverKind,
  ProviderSessionId,
  ProviderThreadId,
  RunId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Schema from "effect/Schema";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import { PendingHumanRequests } from "../threadRecovery/PendingHumanRequests.ts";
import { makePendingHumanItemReader } from "./ProviderTurnStartService.ts";
import { deliverContextHandoffs } from "./ContextHandoffDelivery.ts";
import { makeProviderFailure } from "@t3tools/provider-core/server/failure";

import { historyCost } from "@t3tools/provider-core/server/handoffBudget";

import * as ContextHandoffService from "./ContextHandoffService.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";

// Match S3's canonical error shape while this lane still uses its declaration-only service stub.
class PendingLookupError extends Schema.TaggedError<PendingLookupError>()("ThreadRecoveryError", {
  code: Schema.Literals(["storage"]),
  message: Schema.String,
}) {}

const layerTest = ContextHandoffService.layer.pipe(Layer.provide(IdAllocator.layer));

function importedItem(
  input:
    | {
        readonly role: "user";
        readonly id: string;
        readonly text: string;
        readonly ordinal: number;
      }
    | {
        readonly role: "assistant";
        readonly id: string;
        readonly text: string;
        readonly ordinal: number;
      },
): OrchestrationV2TurnItem {
  const now = DateTime.makeUnsafe("2026-01-01T00:00:00.000Z");
  const base = {
    id: TurnItemId.make(`turn-item:${input.id}`),
    threadId: ThreadId.make("thread:legacy-context"),
    runId: null,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: input.ordinal,
    status: "completed" as const,
    title: null,
    startedAt: now,
    completedAt: now,
    updatedAt: now,
    messageId: MessageId.make(`message:${input.id}`),
    text: input.text,
  };
  return input.role === "user"
    ? {
        ...base,
        createdBy: "user",
        creationSource: "server",
        type: "user_message",
        inputIntent: "turn_start",
        attachments: [],
      }
    : {
        ...base,
        type: "assistant_message",
        streaming: false,
      };
}

it.layer(layerTest)("ContextHandoffService legacy import", (it) => {
  it.effect("prepares imported history for the first native v2 turn", () =>
    Effect.gen(function* () {
      const service = yield* ContextHandoffService.ContextHandoffServiceV2;
      const handoff = yield* service.prepareLegacyImport({
        threadId: ThreadId.make("thread:legacy-context"),
        targetRunId: RunId.make("run:first-v2"),
        toProviderThreadId: ProviderThreadId.make("provider-thread:first-v2"),
        toProviderInstanceId: ProviderInstanceId.make("codex"),
        items: [
          importedItem({ role: "user", id: "one", text: "What did we decide?", ordinal: 1 }),
          importedItem({
            role: "assistant",
            id: "two",
            text: "We decided to keep the migration lightweight.",
            ordinal: 2,
          }),
        ],
        createdAt: DateTime.makeUnsafe("2026-01-02T00:00:00.000Z"),
      });

      assert.equal(handoff.strategy, "manual_context");
      assert.deepStrictEqual(handoff.fromProviderThreadIds, []);
      assert.include(handoff.summaryText, "What did we decide?");
      assert.include(handoff.summaryText, "keep the migration lightweight");
      const providerMessage = ContextHandoffService.providerMessageWithContextHandoff({
        handoff,
        userText: "Continue from there.",
      });
      assert.include(providerMessage, handoff.summaryText);
      assert.include(providerMessage, "User message:\nContinue from there.");
    }),
  );

  it.effect("preserves role attribution when truncating imported history", () =>
    Effect.gen(function* () {
      const service = yield* ContextHandoffService.ContextHandoffServiceV2;
      const handoff = yield* service.prepareLegacyImport({
        threadId: ThreadId.make("thread:legacy-context"),
        targetRunId: RunId.make("run:first-v2"),
        toProviderThreadId: ProviderThreadId.make("provider-thread:first-v2"),
        toProviderInstanceId: ProviderInstanceId.make("codex"),
        items: [
          importedItem({
            role: "user",
            id: "long",
            text: `${"x".repeat(35_000)} retained final words`,
            ordinal: 1,
          }),
        ],
        createdAt: DateTime.makeUnsafe("2026-01-02T00:00:00.000Z"),
      });

      assert.isAtMost(handoff.summaryText.length, 32_000);
      assert.include(handoff.summaryText, "User:\n... retained final words");
      assert.notMatch(handoff.summaryText, /\n+x+ retained final words/);
    }),
  );

  it.effect("retains the newest oversized import even when it has no whitespace", () =>
    Effect.gen(function* () {
      const service = yield* ContextHandoffService.ContextHandoffServiceV2;
      const handoff = yield* service.prepareLegacyImport({
        threadId: ThreadId.make("thread:legacy-context"),
        targetRunId: RunId.make("run:first-v2"),
        toProviderThreadId: ProviderThreadId.make("provider-thread:first-v2"),
        toProviderInstanceId: ProviderInstanceId.make("codex"),
        items: [
          importedItem({
            role: "assistant",
            id: "older",
            text: "older message",
            ordinal: 1,
          }),
          importedItem({
            role: "user",
            id: "long-single-token",
            text: `${"🧪".repeat(20_000)}LATEST_SINGLE_TOKEN`,
            ordinal: 2,
          }),
        ],
        createdAt: DateTime.makeUnsafe("2026-01-02T00:00:00.000Z"),
      });

      assert.include(
        handoff.history?.omittedItemIds ?? [],
        TurnItemId.make("turn-item:long-single-token"),
      );
      assert.isAtMost(handoff.summaryText.length, 32_000);
      assert.include(handoff.summaryText, "User:\n... ");
      assert.include(handoff.summaryText, "LATEST_SINGLE_TOKEN");
      assert.notInclude(handoff.summaryText, "\ufffd");
    }),
  );
  it.effect.each(
    (["success", "error", "timeout"] as const).flatMap((lookup) =>
      (lookup === "success" ? [false] : [false, true]).map((oversized) => ({
        lookup,
        oversized,
        expectation: oversized
          ? "reports context recovery required over budget"
          : "preserves human text through preparation and delivery compaction",
      })),
    ),
  )("pending-human $lookup $expectation", ({ lookup, oversized }) =>
    Effect.gen(function* () {
      const service = yield* ContextHandoffService.ContextHandoffServiceV2;
      const now = DateTime.makeUnsafe("2026-01-02T00:00:00Z");
      const items = Array.from({ length: 100 }, (_, index) => {
        const item = importedItem({
          role: index < 8 ? "user" : "assistant",
          id: `recovery:${index}`,
          text:
            index < 8
              ? // Oversized requests each fit the delivery budget alone, but not together.
                `Unaddressed request ${index}.\n  retain whitespace 🧪 ${oversized ? "human text ".repeat(200) : ""}`
              : "completed history ".repeat(100),
          ordinal: index + 1,
        });
        return { ...item, runId: RunId.make(`run:recovery:${index}`) };
      });
      const humans = items.filter((item) => item.type === "user_message");
      const instanceId = ProviderInstanceId.make("claudeAgent");
      const runs = items.map((item, index) => ({
        id: item.runId,
        threadId: item.threadId,
        ordinal: index + 1,
        providerInstanceId: instanceId,
        modelSelection: { instanceId, model: "claude-opus-5-5" },
        providerThreadId: null,
        userMessageId: MessageId.make(`message:recovery:${index}`),
        rootNodeId: null,
        activeAttemptId: null,
        status: "completed" as const,
        requestedAt: now,
        startedAt: now,
        completedAt: now,
        checkpointId: null,
        contextHandoffId: null,
      }));
      const read = yield* makePendingHumanItemReader.pipe(
        Effect.provide(
          Layer.mock(PendingHumanRequests)({
            listPending: () =>
              lookup === "error"
                ? Effect.fail(
                    new PendingLookupError({
                      code: "storage",
                      message: "storage unavailable",
                    }),
                  )
                : lookup === "timeout"
                  ? Effect.never
                  : Effect.succeed([
                      {
                        turnItemId: humans[0]!.id,
                        sourceMessageId: MessageId.make("message:human"),
                        reason: "unanswered" as const,
                      },
                    ]),
          }),
        ),
      );
      const warnings: Array<string> = [];
      const logger = Logger.layer(
        [
          Logger.make(({ message }) => {
            warnings.push(JSON.stringify(message));
          }),
        ],
        { mergeWithExisting: false },
      );
      const readWindow = (ids: ReadonlyArray<TurnItemId>) =>
        Effect.gen(function* () {
          const lookupEffect = read(items[0]!.threadId, ids).pipe(Effect.provide(logger));
          if (lookup !== "timeout") return yield* lookupEffect;
          const fiber = yield* lookupEffect.pipe(Effect.forkChild);
          yield* TestClock.adjust("5 seconds");
          return yield* Fiber.join(fiber);
        });
      const pendingItemIds = yield* readWindow(humans.map((item) => item.id));
      assert.equal(warnings.length, lookup === "success" ? 0 : 1);
      if (lookup !== "success") {
        assert.include(warnings[0]!, items[0]!.threadId);
        assert.match(warnings[0]!, lookup === "error" ? /storage unavailable/ : /Timeout/);
      }
      const handoff = yield* service.prepareProviderHandoff({
        threadId: items[0]!.threadId,
        targetRunId: RunId.make("run:next"),
        transferId: null,
        fromProviderThreadIds: [],
        toProviderThreadId: ProviderThreadId.make("provider:next"),
        fromProviderInstanceId: instanceId,
        toProviderInstanceId: instanceId,
        coveredRunOrdinals: { from: 1, to: 100 },
        strategy: "full_thread_summary",
        items,
        runs,
        pendingItemIds,
        createdAt: now,
      });
      const protectedHumans = lookup === "success" ? humans.slice(0, 1) : humans;
      for (const human of protectedHumans) {
        assert.equal(
          handoff.history!.messages.find((message) => message.itemId === human.id)?.text,
          human.text,
        );
        assert.notInclude(handoff.history!.omittedItemIds!, human.id);
      }
      if (!oversized) {
        assert.isAbove(handoff.history!.omittedItems, 0);
        assert.isAtMost(historyCost(handoff.history!.messages, handoff.history!.coverage), 16000);
      }
      const deliveryIds = yield* readWindow(
        handoff
          .history!.messages.filter((message) => message.role === "user")
          .map((message) => message.itemId),
      );
      const persisted: Array<string> = [];
      const delivery = yield* deliverContextHandoffs({
        handoffs: [handoff],
        providerThread: {
          id: handoff.toProviderThreadId,
          driver: ProviderDriverKind.make("claudeAgent"),
          providerInstanceId: instanceId,
          providerSessionId: ProviderSessionId.make("session:next"),
          appThreadId: handoff.threadId,
          ownerNodeId: null,
          nativeThreadRef: null,
          nativeConversationHeadRef: null,
          status: "idle",
          firstRunOrdinal: 101,
          lastRunOrdinal: 101,
          handoffIds: [],
          forkedFrom: null,
          createdAt: now,
          updatedAt: now,
        },
        budget: 6000,
        alreadyDeliveredItemIds: new Set(),
        protectedItemIds: new Set(deliveryIds),
        persist: (updated) =>
          Effect.sync(() => {
            persisted.push(updated.id);
          }),
      }).pipe(Effect.result);
      if (oversized) {
        assert.equal(delivery._tag, "Failure");
        if (delivery._tag !== "Failure") return;
        assert.equal(delivery.failure._tag, "ContextRecoveryRequiredError");
        const failure = makeProviderFailure({ cause: delivery.failure });
        assert.equal(failure.code, "context_recovery_required");
        assert.equal(failure.retryable, false);
        assert.deepEqual(persisted, []);
        return;
      }
      assert.equal(delivery._tag, "Success");
      if (delivery._tag !== "Success") return;
      for (const human of protectedHumans) assert.include(delivery.success.context, human.text!);
      assert.isAtMost(Buffer.byteLength(delivery.success.context), 6000);
      if (lookup === "success") {
        // A successful lookup still permits completed, addressed human turns to be omitted.
        assert.notInclude(delivery.success.context, humans[1]!.text!);
      }
    }),
  );
});
