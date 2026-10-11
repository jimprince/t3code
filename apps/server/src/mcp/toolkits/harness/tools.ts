import { HarnessSnapshot, HarnessSnapshotInput, OrchestratorMcpFailure } from "@t3tools/contracts";
import { Tool, Toolkit } from "effect/unstable/ai";
import { HarnessReadService } from "../../../harness/HarnessReadService.ts";
import { ThreadManagementService } from "../../../orchestration-v2/ThreadManagementService.ts";
import { McpInvocationContext } from "../../McpInvocationContext.ts";

export const HarnessToolkit = Toolkit.make(
  Tool.make("harness_snapshot", {
    description:
      "Read Harness agents/checks, exact bounded run histories, lateness evidence and unknown-or-known findings. Read-only; dispatch and execution success are separate. Sources are non-atomic and individually timestamped.",
    parameters: HarnessSnapshotInput,
    success: HarnessSnapshot,
    failure: OrchestratorMcpFailure,
    failureMode: "return",
    dependencies: [HarnessReadService, McpInvocationContext, ThreadManagementService],
  })
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Destructive, false),
);
