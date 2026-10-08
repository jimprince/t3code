import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import { resolveStateFile } from "./state.js";
import { HandoffCause } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Predicate from "effect/Predicate";
import { stableStringify } from "@t3tools/shared/relaySigning";

const isHandoffCause = Schema.is(HandoffCause);

/** Persist before transport. These files contain identities and hashes, never message bodies. */
export async function persistSendIntent(input: {
  sendId: string;
  recipientThreadId: string;
  environment: string;
  text: string;
  coalesceKey?: string | null;
  provenance?: unknown;
}) {
  if (!/^[a-zA-Z0-9._:-]{1,128}$/.test(input.sendId)) throw new Error("INVALID_SEND_ID");
  const directory = NodePath.join(NodePath.dirname(resolveStateFile()), "send-intents");
  await NodeFSP.mkdir(directory, { recursive: true, mode: 0o700 });
  const intent = {
    sendId: input.sendId,
    recipientThreadId: input.recipientThreadId,
    environment: input.environment,
    coalesceKey: input.coalesceKey ?? null,
    payloadHash: NodeCrypto.createHash("sha256")
      .update(stableStringify([input.text, input.provenance ?? null]))
      .digest("hex"),
    createdAt: new Date().toISOString(),
  };
  const filename = NodePath.join(directory, `${input.sendId}.json`);
  let file;
  try {
    file = await NodeFSP.open(filename, "wx", 0o600);
    await file.writeFile(`${JSON.stringify(intent)}\n`);
    await file.sync();
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== "EEXIST") throw cause;
    const existing = await NodeFSP.open(filename, "r");
    try {
      const previous = JSON.parse(await existing.readFile("utf8"));
      for (const key of [
        "sendId",
        "recipientThreadId",
        "environment",
        "coalesceKey",
        "payloadHash",
      ] as const) {
        if (previous[key] !== intent[key]) throw new Error("SEND_ID_CONFLICT");
      }
      await existing.sync();
    } finally {
      await existing.close();
    }
  } finally {
    await file?.close();
  }
  const dir = await NodeFSP.open(directory, "r");
  try {
    await dir.sync();
  } finally {
    await dir.close();
  }
  const parent = await NodeFSP.open(NodePath.dirname(directory), "r");
  try {
    await parent.sync();
  } finally {
    await parent.close();
  }
  return intent;
}

export function sendTransportCause(
  error: unknown,
): "TRANSPORT_TIMEOUT" | "TRANSPORT_OS_ERROR" | "INTERRUPTED" | "TRANSPORT_ERROR" {
  let current = error;
  // The production RPC transport wraps OS errors in typed Socket errors.
  // Inspect bounded structural causes, never stderr or exception messages.
  for (let depth = 0; depth < 4 && Predicate.isObject(current); depth++) {
    const tag = typeof current._tag === "string" ? current._tag : current.name;
    if (tag === "AbortError" || tag === "InterruptedException") return "INTERRUPTED";
    if (
      tag === "TimeoutError" ||
      current.code === "ETIMEDOUT" ||
      (tag === "SocketOpenError" && current.kind === "Timeout")
    )
      return "TRANSPORT_TIMEOUT";
    if (typeof current.code === "string") return "TRANSPORT_OS_ERROR";
    current = current.cause ?? current.reason;
  }
  return "TRANSPORT_ERROR";
}

/** Only structural evidence of failure before admission permits another automatic attempt. */
export function sendWasNeverSubmitted(error: unknown): boolean {
  const chain: Record<string, unknown>[] = [];
  let current = error;
  for (let depth = 0; depth < 4 && Predicate.isObject(current); depth++) {
    chain.push(current);
    current = current.cause ?? current.reason;
  }
  // An open timeout can actually be RpcClient's heartbeat failure on an OPEN socket.
  if (
    chain.some((value) => {
      const tag = value._tag ?? value.name;
      return (
        tag === "TimeoutError" ||
        tag === "AbortError" ||
        tag === "InterruptedException" ||
        value.code === "ETIMEDOUT" ||
        (tag === "SocketOpenError" && value.kind === "Timeout") ||
        ["SocketReadError", "SocketWriteError", "SocketCloseError"].includes(String(tag))
      );
    })
  )
    return false;
  return chain.some((value) => {
    const tag = value._tag ?? value.name;
    return (
      (tag === "SocketOpenError" && value.kind === "Unknown") ||
      tag === "EnvironmentAuthorizationError" ||
      (["ECONNREFUSED", "EHOSTUNREACH", "ENOTFOUND"].includes(String(value.code)) &&
        ["connect", "getaddrinfo"].includes(String(value.syscall)))
    );
  });
}

/** Watcher callers must preserve uncertainty instead of treating a returned result as delivery. */
export function sendOutcomeFailure(outcome: unknown): {
  status: "uncertain" | "undeliverable";
  retryable: boolean;
  causeCode: string;
  sendId?: string;
} | null {
  if (!Predicate.isObject(outcome) || outcome.dispatched !== false || outcome.queued !== false)
    return null;
  return {
    status: outcome.uncertain === true ? "uncertain" : "undeliverable",
    retryable: outcome.uncertain !== true && outcome.retryable === true,
    causeCode: isHandoffCause(outcome.causeCode) ? outcome.causeCode : "TRANSPORT_ERROR",
    ...(typeof outcome.sendId === "string" ? { sendId: outcome.sendId } : {}),
  };
}

export function sendOutcomeHeld(outcome: unknown): boolean {
  return (
    Predicate.isObject(outcome) &&
    Predicate.isObject(outcome.receipt) &&
    outcome.receipt.status === "held"
  );
}
