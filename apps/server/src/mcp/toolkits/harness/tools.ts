import {
  HarnessPinnedChecks,
  HarnessSetCheckPinnedInput,
  HarnessSnapshot,
  HarnessSnapshotInput,
  OrchestratorMcpFailure,
} from "@t3tools/contracts";
import { Tool, Toolkit } from "effect/ai";
import * as ServerEnvironment from "../../../environment/ServerEnvironment.ts";
import { HarnessPinService } from "../../../harness/HarnessPinService.ts";
import { HarnessReadService } from "../../../harness/HarnessReadService.ts";
import { ThreadManagementService } from "../../../orchestration-v2/ThreadManagementService.ts";
import { McpInvocationContext } from "../../McpInvocationContext.ts";

export const HarnessToolkit = Toolkit.make(
  Tool.make("harness_snapshot", {
    description:
      "Read Harness agents/checks, exact bounded run histories, lateness evidence and unknown-or-known findings. Read-only; dispatch and execution success are separate. Sources are non-atomic and individually timestamped. pinnedCheckKeys lists the checks pinned to the top of the checks list; it is absent on a server that cannot pin.",
    parameters: HarnessSnapshotInput,
    success: HarnessSnapshot,
    failure: OrchestratorMcpFailure,
    failureMode: "return",
    dependencies: [HarnessReadService, McpInvocationContext, ThreadManagementService],
  })
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Destructive, false),
  Tool.make("harness_check_pin", {
    description:
      "Pin a Harness check to the top of the checks list, or unpin it, for every client of this environment. checkKey is a routine key from harness_snapshot; a key no check reports is kept harmlessly and can be unpinned. Returns every pinned key after the change. Requires a live full-access/default calling thread.",
    parameters: HarnessSetCheckPinnedInput,
    success: HarnessPinnedChecks,
    failure: OrchestratorMcpFailure,
    failureMode: "return",
    dependencies: [
      HarnessPinService,
      McpInvocationContext,
      ThreadManagementService,
      ServerEnvironment.ServerEnvironment,
    ],
  }).annotate(Tool.Destructive, false),
);
