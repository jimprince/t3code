import {
  OrchestratorMcpFailure,
  SubheadMcpSendInput,
  SubheadRunIdInput,
  SubheadRunReceipt,
  SubheadResult,
} from "@t3tools/contracts";
import { Tool, Toolkit } from "effect/ai";
import { SubheadMcpService } from "../../SubheadMcpService.ts";
import { McpInvocationContext } from "../../McpInvocationContext.ts";
import { ThreadManagementService } from "../../../orchestration-v2/ThreadManagementService.ts";

const dependencies = [SubheadMcpService, McpInvocationContext, ThreadManagementService];
const send = Tool.make("subhead_send", {
  description:
    "Invoke an enabled virtual helper by name. Persist clientRequestId before retrying: exact retries return the same run, conflicting content rejects. The app freezes the template, launches one fresh thread under its owning head and returns one durable result to this authenticated calling thread. Outside MCP clients use pull-only results. Authenticated virtual-run thread calls cannot invoke another subhead; unrestricted shell access to another principal's credentials is outside this tool-level guarantee. Parameters cannot override the authenticated sender or return destination. Read status/result using runId; do not send a second completion yourself.",
  parameters: SubheadMcpSendInput,
  success: SubheadRunReceipt,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Send to a virtual helper")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, true);
const status = Tool.make("subhead_status", {
  description:
    "Read this authenticated sender's virtual helper run, pinned template version, queue reason and durable delivery state. This does not wake the worker or recipient.",
  parameters: SubheadRunIdInput,
  success: SubheadRunReceipt,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Read virtual helper status")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);
const result = Tool.make("subhead_result", {
  description:
    "Pull this authenticated sender's durable virtual helper result. result is null while work is unfinished. Held or undelivered thread returns remain visible here and are never rerouted.",
  parameters: SubheadRunIdInput,
  success: SubheadResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Read virtual helper result")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);
export const SubheadToolkit = Toolkit.make(send, status, result);
