import type { OrchestrationLatestTurn, OrchestrationSession } from "@t3tools/contracts";

/**
 * Outcome of a run whose message is not bound to a turn. A message sent into an
 * existing thread keeps a null turnId, so the run is matched to the thread's
 * latest turn requested at or after the message. A stopped or errored session
 * only fails the run when it changed after the message and no such turn exists:
 * sessions stop on their own once a turn ends, and an older stop is stale.
 * Returns null while the run is still waiting.
 */
export function unboundRunOutcome(input: {
  readonly messageCreatedAt: string;
  readonly latestTurn: OrchestrationLatestTurn | null;
  readonly session: OrchestrationSession | null;
}): { readonly status: "completed" | "failed"; readonly result: string } | null {
  const sent = Date.parse(input.messageCreatedAt);
  const turn = input.latestTurn;
  if (turn && Date.parse(turn.requestedAt) >= sent) {
    if (turn.state === "running") return null;
    return turn.state === "completed"
      ? { status: "completed", result: "Turn completed." }
      : { status: "failed", result: `Turn ${turn.state}.` };
  }
  const session = input.session;
  if (
    session &&
    (session.status === "error" || session.status === "stopped") &&
    Date.parse(session.updatedAt) >= sent
  )
    return {
      status: "failed",
      result: session.lastError ?? "Provider session stopped before completion.",
    };
  return null;
}
