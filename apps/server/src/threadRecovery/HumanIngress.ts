import * as Context from "effect/Context";
/** Authenticated human principal from a client transport; absent for provider/MCP/automation work. */
export class HumanIngress extends Context.Reference<string | null>(
  "t3/threadRecovery/HumanIngress",
  { defaultValue: () => null },
) {}
