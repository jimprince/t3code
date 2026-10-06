import { createEnvironmentRpcQueryAtomFamily } from "@t3tools/client-runtime/state/runtime";

import { connectionAtomRuntime } from "../connection/runtime";

/** One page of a thread's read-only V1 history; imported V1 threads answer with their sections. */
export const legacyHistoryQuery = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "environment-data:legacy-history:get",
  tag: "orchestration.getLegacyHistory",
  staleTimeMs: 60_000,
  idleTtlMs: 0,
});
