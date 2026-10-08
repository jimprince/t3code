import {
  isOrchestrationV2WorkActive,
  type OrchestrationV2ProviderSession,
  type OrchestrationV2ProviderTurn,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

/** An old terminal receipt cannot settle a provider start that began after it. */
export function canReconcileStartingSession(
  projection: Pick<OrchestrationV2ThreadProjection, "runs" | "providerTurns">,
  session: OrchestrationV2ProviderSession,
  turn: OrchestrationV2ProviderTurn,
): boolean {
  return (
    session.status !== "starting" ||
    (turn.completedAt !== null &&
      DateTime.toEpochMillis(session.updatedAt) <= DateTime.toEpochMillis(turn.completedAt) &&
      !projection.providerTurns.some((turn) => isOrchestrationV2WorkActive(turn.status)) &&
      !projection.runs.some((run) =>
        ["queued", "preparing", "starting", "running", "waiting"].includes(run.status),
      ))
  );
}
