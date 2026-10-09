import {
  SessionResetInput,
  SessionResetReceipt,
  HandoverPrepareInput,
  HandoverReceipt,
  HandoverCommitInput,
  HandoverStatusInput,
  HandoverRoutesInput,
  HandoverHostReceipt,
  HumanPendingInput,
  HumanPendingResult,
  HumanResolveInput,
  ThreadRecoveryError,
} from "@t3tools/contracts";
import { Tool, Toolkit } from "effect/ai";
import * as McpToolAccess from "../../McpToolAccess.ts";
import * as Effect from "effect/Effect";

/** No administrative MCP grant is minted in this lane, even for full-access provider sessions. */
const description =
  "Administrative recovery requires an authenticated access:write + orchestration:operate WS/CLI credential. Current provider MCP credentials are refused; full-access runtime is not an administrative grant.";
const policy = { description, failure: ThreadRecoveryError, failureMode: "return" as const };
export const RecoveryToolkit = Toolkit.make(
  Tool.make("thread_session_reset", {
    ...policy,
    parameters: SessionResetInput,
    success: SessionResetReceipt,
  }),
  Tool.make("thread_handover_prepare", {
    ...policy,
    parameters: HandoverPrepareInput,
    success: HandoverReceipt,
  }),
  Tool.make("thread_handover_commit", {
    ...policy,
    parameters: HandoverCommitInput,
    success: HandoverReceipt,
  }),
  Tool.make("thread_handover_status", {
    ...policy,
    parameters: HandoverStatusInput,
    success: HandoverReceipt,
  }),
  Tool.make("thread_handover_routes", {
    ...policy,
    parameters: HandoverRoutesInput,
    success: HandoverHostReceipt,
  }),
  Tool.make("thread_human_pending", {
    ...policy,
    parameters: HumanPendingInput,
    success: HumanPendingResult,
  }),
  Tool.make("thread_human_resolve", {
    ...policy,
    parameters: HumanResolveInput,
    success: HumanPendingResult,
  }),
);
const refused = () =>
  Effect.fail(new ThreadRecoveryError({ code: "forbidden", message: description }));
export const RecoveryHandlersLive = McpToolAccess.toLayer(
  RecoveryToolkit,
  Effect.succeed({
    thread_session_reset: McpToolAccess.reads(refused),
    thread_handover_prepare: McpToolAccess.reads(refused),
    thread_handover_commit: McpToolAccess.reads(refused),
    thread_handover_status: McpToolAccess.reads(refused),
    thread_handover_routes: McpToolAccess.reads(refused),
    thread_human_pending: McpToolAccess.reads(refused),
    thread_human_resolve: McpToolAccess.reads(refused),
  }),
);
