import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { expect } from "vite-plus/test";
import {
  RunId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2HistoricalMessage,
} from "@t3tools/contracts";
import { historyCost, selectRecoveryHistory } from "../orchestration-v2/ContextHandoffBudget.ts";
import { makePendingHumanItemReader } from "../orchestration-v2/ProviderTurnStartService.ts";
import { HumanIngress } from "./HumanIngress.ts";
import { execute, old, seed, seedConversation } from "./Recovery.testkit.ts";

const BUDGET = 16_000;
const turns = 30;
const interruptedTurn = 12;
const distinctive = "PENDING-RUN-12: rotate the staging credentials before Friday.";

// Mirrors the projected history the handoff sees after restart: every turn is long enough
// that keeping all 31 human requests verbatim exceeds the default handoff cap.
const history = (): OrchestrationV2HistoricalMessage[] =>
  Array.from({ length: turns + 1 }, (_, index) => {
    const turn = index + 1;
    const interrupted = turn === interruptedTurn;
    const newest = turn === turns + 1;
    const base = {
      threadId: ThreadId.make("old"),
      runId: RunId.make(`run-${turn}`),
      providerThreadId: null,
      kind: "message",
    };
    const user: OrchestrationV2HistoricalMessage = {
      ...base,
      role: "user",
      itemId: TurnItemId.make(`item-human-${turn}`),
      text: interrupted ? distinctive : `Request ${turn} ${"r".repeat(560)}`,
      runStatus: interrupted ? "interrupted" : newest ? "running" : "completed",
      status: "completed",
    };
    if (interrupted || newest) return [user];
    return [
      user,
      {
        ...base,
        role: "assistant",
        itemId: TurnItemId.make(`item-answer-${turn}`),
        text: `Answer ${turn} ${"a".repeat(200)}`,
        runStatus: "completed",
        status: "completed",
      } satisfies OrchestrationV2HistoricalMessage,
    ];
  }).flat();

it.live(
  "restart recovery of a 30-turn thread keeps only open requests verbatim and fits the handoff cap",
  () =>
    execute(
      Effect.gen(function* () {
        yield* seed("completed").pipe(Effect.provideService(HumanIngress, "Brad"));
        yield* seedConversation(turns + 1, { [interruptedTurn]: "interrupted", 31: "running" });
        const messages = history();
        const humanItemIds = messages.filter((m) => m.role === "user").map((m) => m.itemId);
        const coverage = "Context handoff (full_thread_summary)";
        // The UAT shape: protecting every human request cannot fit.
        expect(
          historyCost(
            messages.filter((m) => m.role === "user"),
            coverage,
          ),
        ).toBeGreaterThan(BUDGET);

        const read = yield* makePendingHumanItemReader;
        const pending = yield* read(old, humanItemIds);
        expect(pending).toEqual([
          TurnItemId.make(`item-human-${interruptedTurn}`),
          TurnItemId.make(`item-human-${turns + 1}`),
        ]);
        const selected = selectRecoveryHistory({
          messages,
          coverage,
          budget: BUDGET,
          protectedItemIds: new Set(pending),
        });
        // deliverContextHandoffs raises ContextRecoveryRequiredError exactly when this exceeds the cap.
        expect(historyCost(selected.messages, selected.context)).toBeLessThanOrEqual(BUDGET);
        expect(selected.messages.find((m) => m.itemId === pending[0])?.text).toBe(distinctive);
        expect(selected.messages.some((m) => m.itemId === pending[1])).toBe(true);
        expect(selected.omittedItems).toBeGreaterThan(0);
        expect(selected.context).toContain("Deterministic recovery summary");
      }),
    ),
);
