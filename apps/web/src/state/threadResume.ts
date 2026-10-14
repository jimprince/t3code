import { WS_METHODS } from "@t3tools/contracts";
import { createEnvironmentRpcCommand } from "@t3tools/client-runtime/state/runtime";

import { connectionAtomRuntime } from "../connection/runtime";

/** A stopped thread with steps left becomes a fresh thread seeded with its plan; idempotent. */
export const resumeThreadFromPlan = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:thread:resume-from-plan",
  tag: WS_METHODS.threadResumeFromPlan,
});
