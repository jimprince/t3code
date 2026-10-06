import {
  CommandId,
  type EnvironmentId,
  type ProjectId,
  type ThreadId,
  ORCHESTRATION_V2_WS_METHODS,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as EnvironmentRegistry from "../connection/registry.ts";
import * as Rpc from "../rpc/client.ts";
import { transferSourceUpdatedAt } from "./transferSource.ts";

/** Import acknowledgment is durable. Source archival is last and rejects post-export edits. */
export const moveThread = Effect.fn("moveThread")(function* (input: {
  sourceEnvironmentId: EnvironmentId;
  targetEnvironmentId: EnvironmentId;
  sourceThreadId: ThreadId;
  targetProjectId: ProjectId;
  branchConflict?: "fail" | "new-worktree";
}) {
  if (input.sourceEnvironmentId === input.targetEnvironmentId)
    throw new Error("Choose a different environment.");
  const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
  const exported = yield* registry.run(
    input.sourceEnvironmentId,
    Rpc.request("orchestration.exportThread", { threadId: input.sourceThreadId }),
  );
  const imported = yield* registry.run(
    input.targetEnvironmentId,
    Rpc.request("orchestration.importThread", {
      projectId: input.targetProjectId,
      bundle: exported.bundle,
      ...(input.branchConflict === undefined ? {} : { branchConflict: input.branchConflict }),
    }),
  );
  if (!imported.durable || imported.receipt.length === 0)
    throw new Error("Destination did not acknowledge durable import.");
  yield* registry.run(
    input.sourceEnvironmentId,
    Rpc.request(ORCHESTRATION_V2_WS_METHODS.dispatchCommand, {
      type: "thread.archive",
      commandId: CommandId.make(`transfer:archive:${imported.receipt}`),
      threadId: input.sourceThreadId,
      transferExpectedUpdatedAt: transferSourceUpdatedAt(exported.bundle),
    }),
  );
  return imported;
});
