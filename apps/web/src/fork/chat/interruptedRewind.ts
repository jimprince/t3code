import type { RunId } from "@t3tools/contracts";
import type { ChatMessage } from "../../types";
import type { ThreadCheckpointSummary } from "@t3tools/client-runtime/state/thread-checkpoints";
import type { ThreadRunSummary } from "@t3tools/client-runtime/state/shell";
/** Only the last terminal start message gets the missing-checkpoint fallback. */
export function interruptedRewindBoundary(input: {
  latestRun: Pick<ThreadRunSummary, "runId" | "status"> | null;
  runningRunId: RunId | null;
  messages: ReadonlyArray<Pick<ChatMessage, "id" | "role" | "runId" | "inputIntent" | "createdAt">>;
  checkpoints: ReadonlyArray<ThreadCheckpointSummary>;
}) {
  const run = input.latestRun;
  if (
    run === null ||
    input.runningRunId !== null ||
    (run.status !== "interrupted" && run.status !== "failed")
  )
    return null;
  const message = input.messages.findLast((message) => message.role === "user");
  if (
    !message ||
    message.runId !== run.runId ||
    (message.inputIntent !== "turn_start" && message.inputIntent !== "queued_turn")
  )
    return null;
  if (
    input.checkpoints.some(
      (checkpoint) => checkpoint.runId === run.runId && checkpoint.status === "ready",
    )
  )
    return null;
  const prior = input.checkpoints.filter(
    (checkpoint) =>
      checkpoint.status === "ready" &&
      checkpoint.runId !== run.runId &&
      checkpoint.completedAt !== null &&
      Date.parse(checkpoint.completedAt) < Date.parse(message.createdAt),
  );
  return {
    messageId: message.id,
    turnCount: Math.max(0, ...prior.map((checkpoint) => checkpoint.checkpointTurnCount)),
  };
}
