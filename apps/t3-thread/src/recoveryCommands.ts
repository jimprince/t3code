import {
  SendBindingInput,
  ThreadResumeInput,
  ThreadGenerationInput,
  ThreadStopInput,
  SessionResetInput,
  HandoverPrepareInput,
  HandoverRoutesInput,
  HandoverCommitInput,
  HumanPendingInput,
  HumanResolveInput,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as NodeFSP from "node:fs/promises";
import type { Command } from "commander";
import type { RemoteEnvironmentClient } from "./client.js";

/** Thin CLI: validated targets and real paired WS authority, never caller identity impersonation. */
export function registerRecoveryCommands(
  agent: Command,
  session: Command,
  withAgent: (reference: string) => Promise<{
    agent: { threadId: string; environment: string };
    client: RemoteEnvironmentClient;
  }>,
  withEnvironment: (name: string) => Promise<RemoteEnvironmentClient>,
  print: (value: unknown) => void,
) {
  agent
    .command("send-binding")
    .argument("<thread>")
    .argument("<send-id>")
    .action(async (reference, sendId) => {
      const { agent: target, client } = await withAgent(reference);
      print(
        await client.recoveryRpc(
          "thread.send.binding",
          Schema.decodeUnknownSync(SendBindingInput)({ threadId: target.threadId, sendId }),
        ),
      );
    });
  session
    .command("generation")
    .argument("<thread>")
    .action(async (reference) => {
      const { agent: target, client } = await withAgent(reference);
      print(
        await client.recoveryRpc(
          "thread.session.generation",
          Schema.decodeUnknownSync(ThreadGenerationInput)({ threadId: target.threadId }),
        ),
      );
    });
  session
    .command("stop-receipt")
    .argument("<thread>")
    .requiredOption("--run-id <id>")
    .action(async (reference, options) => {
      const { agent: target, client } = await withAgent(reference);
      print(
        await client.recoveryRpc(
          "thread.stop.receipt",
          Schema.decodeUnknownSync(ThreadStopInput)({
            threadId: target.threadId,
            runId: options.runId,
          }),
        ),
      );
    });
  agent
    .command("resume")
    .argument("<thread>")
    .requiredOption("--expected-generation <number>")
    .requiredOption("--request-id <id>")
    .option("--message <text>")
    .action(async (reference, options) => {
      const { agent: target, client } = await withAgent(reference);
      print(
        await client.recoveryRpc(
          "thread.resume",
          Schema.decodeUnknownSync(ThreadResumeInput)({
            threadId: target.threadId,
            expectedGeneration: Number(options.expectedGeneration),
            requestId: options.requestId,
            ...(options.message === undefined ? {} : { message: options.message }),
          }),
        ),
      );
    });
  session
    .command("reset")
    .argument("<thread>")
    .requiredOption("--run-id <id>")
    .requiredOption("--expected-generation <number>")
    .requiredOption("--request-id <id>")
    .option("--reason <reason>", "watchdog_force, operator_reset, discard_native", "operator_reset")
    .action(async (reference, options) => {
      const { agent: target, client } = await withAgent(reference);
      const input = Schema.decodeUnknownSync(SessionResetInput)({
        threadId: target.threadId,
        runId: options.runId,
        expectedGeneration: Number(options.expectedGeneration),
        requestId: options.requestId,
        reason: options.reason,
      });
      print(await client.recoveryRpc("thread.session.reset", input));
    });
  const handover = agent
    .command("handover")
    .description("Prepare, transfer host routes, and commit an administrative handover");
  handover
    .command("prepare")
    .argument("<old>")
    .argument("<successor>")
    .requiredOption("--expected-generation <number>")
    .requiredOption("--request-id <id>")
    .requiredOption("--reason <reason>")
    .requiredOption("--required-environments <ids>", "comma separated host environment UUIDs")
    .action(async (old, successor, options) => {
      const { agent: target, client } = await withAgent(old);
      const { agent: replacement } = await withAgent(successor);
      if (target.environment !== replacement.environment)
        throw new Error("Source and successor must belong to the same hosting environment.");
      const input = Schema.decodeUnknownSync(HandoverPrepareInput)({
        oldThreadId: target.threadId,
        successorThreadId: replacement.threadId,
        expectedGeneration: Number(options.expectedGeneration),
        requestId: options.requestId,
        reason: options.reason,
        requiredEnvironments: options.requiredEnvironments.split(","),
      });
      print(await client.recoveryRpc("thread.handover.prepare", input));
    });
  handover
    .command("routes")
    .requiredOption("--host <environment>", "paired server whose operator routes are transferred")
    .requiredOption("--transfer-id <id>")
    .requiredOption("--old-thread-id <id>")
    .requiredOption("--successor-thread-id <id>")
    .requiredOption("--target-environment <name>", "operator saved name of the hosting environment")
    .requiredOption("--expected-generation <number>")
    .requiredOption("--request-id <id>")
    .requiredOption("--reason <reason>")
    .action(async (options) => {
      const client = await withEnvironment(options.host);
      const input = Schema.decodeUnknownSync(HandoverRoutesInput)({
        transferId: options.transferId,
        oldThreadId: options.oldThreadId,
        successorThreadId: options.successorThreadId,
        targetEnvironment: options.targetEnvironment,
        expectedGeneration: Number(options.expectedGeneration),
        requestId: options.requestId,
        reason: options.reason,
      });
      print(await client.recoveryRpc("thread.handover.routes", input));
    });
  handover
    .command("commit")
    .argument("<old>")
    .requiredOption("--transfer-id <id>")
    .requiredOption("--request-id <id>")
    .requiredOption("--receipts-file <path>", "JSON array of host receipts; maximum 1 MiB")
    .action(async (reference, options) => {
      const { client } = await withAgent(reference);
      if ((await NodeFSP.stat(options.receiptsFile)).size > 1048576)
        throw new Error("Receipt file exceeds 1 MiB.");
      const input = Schema.decodeUnknownSync(HandoverCommitInput)({
        transferId: options.transferId,
        requestId: options.requestId,
        hostReceipts: JSON.parse(await NodeFSP.readFile(options.receiptsFile, "utf8")),
      });
      print(await client.recoveryRpc("thread.handover.commit", input));
    });
  handover
    .command("status")
    .argument("<old>")
    .requiredOption("--transfer-id <id>")
    .action(async (reference, options) => {
      const { client } = await withAgent(reference);
      print(await client.recoveryRpc("thread.handover.status", { transferId: options.transferId }));
    });
  const human = agent
    .command("human")
    .description("Inspect and explicitly address pending human requests");
  human
    .command("pending-list")
    .argument("<thread>")
    .action(async (reference) => {
      const { agent: target, client } = await withAgent(reference);
      print(
        await client.recoveryRpc(
          "thread.human.pending.list",
          Schema.decodeUnknownSync(ThreadGenerationInput)({ threadId: target.threadId }),
        ),
      );
    });
  human
    .command("pending")
    .argument("<thread>")
    .option("--after-message-id <id>")
    .action(async (reference, options) => {
      const { agent: target, client } = await withAgent(reference);
      print(
        await client.recoveryRpc(
          "thread.human.pending",
          Schema.decodeUnknownSync(HumanPendingInput)({
            threadId: target.threadId,
            ...(options.afterMessageId ? { afterMessageId: options.afterMessageId } : {}),
          }),
        ),
      );
    });
  human
    .command("resolve")
    .argument("<thread>")
    .requiredOption("--item-ids <ids>")
    .requiredOption("--reference <reference>", "explicit answer/disposition evidence")
    .action(async (reference, options) => {
      const { agent: target, client } = await withAgent(reference);
      print(
        await client.recoveryRpc(
          "thread.human.resolve",
          Schema.decodeUnknownSync(HumanResolveInput)({
            threadId: target.threadId,
            itemIds: options.itemIds.split(","),
            reference: options.reference,
          }),
        ),
      );
    });
}
