import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import type { HandoffReceipt } from "@t3tools/contracts";
import type { RemoteEnvironmentClient } from "./client.js";
import { resolveStateFile } from "./state.js";

/** JS trim(), then every run of JS /\s/u whitespace becomes one ASCII space.
 * Hash the JSON tuple to keep target/body boundaries unambiguous; preserve case. */
export function duplicateSendHash(threadId: string, body: string): string {
  return NodeCrypto.createHash("sha256")
    .update(JSON.stringify([threadId, body.trim().replace(/\s+/gu, " ")]))
    .digest("hex");
}

export type DuplicateSendMetadata = { hash: string; senderThreadId: string | null };
type LocalSend = {
  sendId: string;
  recipientThreadId: string;
  environment: string;
  createdAt: string;
  duplicateSend?: DuplicateSendMetadata;
  receipt?: HandoffReceipt;
};

export function duplicateSendCandidate(input: {
  previous: LocalSend;
  metadata: DuplicateSendMetadata;
  environment: string;
  sendId?: string;
  force?: boolean;
  coalesceKey?: string | null;
}): boolean {
  const { previous } = input;
  return (
    !input.force &&
    !input.coalesceKey &&
    previous.sendId !== input.sendId &&
    previous.environment === input.environment &&
    previous.duplicateSend?.hash === input.metadata.hash &&
    previous.duplicateSend.senderThreadId === input.metadata.senderThreadId
  );
}

export function duplicateSendState(receipt: HandoffReceipt): string | null {
  if (!["held", "started", "steered", "queued", "accepted"].includes(receipt.status)) return null;
  if (receipt.run?.terminal) return null;
  return receipt.run?.status ?? `${receipt.status} (run state unknown; treated as not terminal)`;
}

/** Refresh matching local intents through the existing receipt read. The latest
 * thread turn cannot prove that a particular older send has finished. */
export async function refuseDuplicateSend(input: {
  client: Pick<RemoteEnvironmentClient, "lookupSendReceipt">;
  threadId: string;
  metadata: DuplicateSendMetadata;
  environment: string;
  sendId?: string;
  force?: boolean;
  coalesceKey?: string | null;
}): Promise<void> {
  if (input.force || input.coalesceKey) return;
  const directory = NodePath.join(NodePath.dirname(resolveStateFile()), "send-intents");
  let files: string[];
  try {
    files = await NodeFSP.readdir(directory);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return;
    throw cause;
  }
  // An existing explicit ID is a retry. The existing intent/server checks still
  // enforce its exact payload; another intentional send must not block recovery.
  if (input.sendId && files.includes(`${input.sendId}.json`)) return;
  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    const previous: LocalSend = JSON.parse(
      await NodeFSP.readFile(NodePath.join(directory, file), "utf8"),
    );
    if (!duplicateSendCandidate({ ...input, previous })) continue;
    let receipt = previous.receipt;
    if (receipt && duplicateSendState(receipt) === null) continue;
    let unavailable = false;
    try {
      const result = await input.client.lookupSendReceipt({
        type: "exact",
        sendId: previous.sendId,
      });
      const current =
        result.state === "found"
          ? result.receipts.find(
              (value) =>
                value.sendId === previous.sendId && value.recipientThreadId === input.threadId,
            )
          : undefined;
      if (current) {
        receipt = current;
        await recordSendReceipt(current);
      } else unavailable = true;
    } catch {
      unavailable = true;
    }
    const state =
      unavailable || !receipt
        ? "unknown (receipt read unavailable; treated as not terminal)"
        : duplicateSendState(receipt);
    if (state !== null) {
      throw new Error(
        `duplicate of send ${previous.sendId} at ${receipt?.acceptedAt ?? previous.createdAt} to ${input.threadId}; that run is ${state}; use --force to send anyway`,
      );
    }
  }
}

/** Cache delivery evidence in the existing private intent, without storing the body. */
export async function recordSendReceipt(receipt: HandoffReceipt): Promise<void> {
  const filename = NodePath.join(
    NodePath.dirname(resolveStateFile()),
    "send-intents",
    `${receipt.sendId}.json`,
  );
  const previous = JSON.parse(await NodeFSP.readFile(filename, "utf8"));
  if (!previous.duplicateSend) return;
  const temporary = `${filename}.${NodeCrypto.randomUUID()}.tmp`;
  const file = await NodeFSP.open(temporary, "wx", 0o600);
  try {
    await file.writeFile(`${JSON.stringify({ ...previous, receipt })}\n`);
    await file.sync();
  } finally {
    await file.close();
  }
  await NodeFSP.rename(temporary, filename);
  const directory = await NodeFSP.open(NodePath.dirname(filename), "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}
