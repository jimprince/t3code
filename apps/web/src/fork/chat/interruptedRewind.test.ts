import { expect, it } from "vite-plus/test";
import { MessageId, RunId } from "@t3tools/contracts";
import { interruptedRewindBoundary } from "./interruptedRewind";
type Input = Parameters<typeof interruptedRewindBoundary>[0];
const runId = RunId.make("interrupted");
const input: Input = {
  latestRun: { runId, status: "interrupted" },
  runningRunId: null,
  messages: [
    {
      id: MessageId.make("user"),
      role: "user",
      runId,
      inputIntent: "turn_start",
      createdAt: "2026-10-05T00:00:10Z",
    },
  ],
  checkpoints: [],
};
it("offers a conversation baseline without assistant response or checkpoint", () =>
  expect(interruptedRewindBoundary(input)?.turnCount).toBe(0));
it("uses the last earlier ready checkpoint and excludes stale/missing/later boundaries", () => {
  const checkpoints = [
    {
      runId: RunId.make("prior"),
      status: "ready",
      checkpointTurnCount: 3,
      completedAt: "2026-10-05T00:00:05Z",
    },
    {
      runId: RunId.make("later"),
      status: "ready",
      checkpointTurnCount: 8,
      completedAt: "2026-10-05T00:00:15Z",
    },
    {
      runId: RunId.make("missing"),
      status: "missing",
      checkpointTurnCount: 4,
      completedAt: "2026-10-05T00:00:06Z",
    },
  ] as unknown as Input["checkpoints"];
  expect(interruptedRewindBoundary({ ...input, checkpoints })?.turnCount).toBe(3);
});
it("denies active runs, non-start user inputs, and older user messages", () => {
  expect(interruptedRewindBoundary({ ...input, runningRunId: runId })).toBe(null);
  expect(interruptedRewindBoundary({ ...input, latestRun: { runId, status: "running" } })).toBe(
    null,
  );
  expect(
    interruptedRewindBoundary({
      ...input,
      messages: [{ ...input.messages[0]!, inputIntent: "steer" }],
    }),
  ).toBe(null);
  expect(
    interruptedRewindBoundary({
      ...input,
      messages: [{ ...input.messages[0]!, runId: RunId.make("old") }],
    }),
  ).toBe(null);
});
