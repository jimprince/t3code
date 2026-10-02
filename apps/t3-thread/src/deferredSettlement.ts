import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import { resolveStateFile } from "./state.js";
import { classifyThread } from "./status.js";
import type { OrchestrationThread } from "./types.js";

export interface SettlementRequest {
  threadId: string;
  environment: string;
  turnId: string;
  unsettledAt: string | null;
  cancellationToken?: string | null;
}

interface SettlementClient {
  findThread(threadId: string): Promise<OrchestrationThread>;
  settleThread(threadId: string, options: { self: boolean }): Promise<unknown>;
}

const MAX_WAIT_MS = 24 * 60 * 60 * 1000;

/** Wait for this response to persist before invoking the normal server lifecycle. */
export async function settleAfterTurn(
  request: SettlementRequest,
  client: SettlementClient,
  options: {
    now?: () => number;
    wait?: () => Promise<void>;
    timeoutMs?: number;
    isCancelled?: () => Promise<boolean>;
  } = {},
): Promise<unknown> {
  const now = options.now ?? Date.now;
  const wait = options.wait ?? (() => new Promise((resolve) => setTimeout(resolve, 5000)));
  const deadline = now() + (options.timeoutMs ?? MAX_WAIT_MS);
  let lastError: string | null = null;
  while (now() < deadline) {
    try {
      if (await options.isCancelled?.()) {
        return { ...request, deferred: false, cancelled: true, reason: "Cancelled by unsettle." };
      }
      const thread = await client.findThread(request.threadId);
      if (
        thread.archivedAt ||
        thread.deletedAt ||
        thread.latestTurn?.turnId !== request.turnId ||
        (thread.unsettledAt ?? null) !== request.unsettledAt
      ) {
        return {
          ...request,
          deferred: false,
          cancelled: true,
          reason: "Thread changed after the request.",
        };
      }
      const state = classifyThread(thread).state;
      if (["error", "interrupted", "needs-plan"].includes(state)) {
        return {
          ...request,
          deferred: false,
          cancelled: true,
          reason: `Thread needs attention (${state}).`,
        };
      }
      const response = thread.messages.find(
        (message) => message.id === thread.latestTurn?.assistantMessageId,
      );
      if (
        state === "completed" &&
        thread.latestTurn?.completedAt &&
        response?.role === "assistant" &&
        response.turnId === request.turnId &&
        !response.streaming
      ) {
        // The server still checks active/queued work and unresolved requests.
        if (await options.isCancelled?.()) {
          return { ...request, deferred: false, cancelled: true, reason: "Cancelled by unsettle." };
        }
        const result = await client.settleThread(request.threadId, { self: true });
        return { ...request, deferred: false, settled: true, result };
      }
    } catch (error) {
      // A connection failure or raced server guard must never become success.
      lastError = error instanceof Error ? error.message : String(error);
    }
    await wait();
  }
  throw new Error(
    `Deferred settlement expired for '${request.threadId}'.${lastError ? ` Last error: ${lastError}` : ""}`,
  );
}

function cancellationFile(request: Pick<SettlementRequest, "environment" | "threadId">): string {
  const key = NodeCrypto.createHash("sha256")
    .update(JSON.stringify([request.environment, request.threadId]))
    .digest("hex");
  return NodePath.join(NodePath.dirname(resolveStateFile()), "settlements", `${key}.cancel`);
}

async function cancellationToken(request: SettlementRequest): Promise<string | null> {
  try {
    return await NodeFSP.readFile(cancellationFile(request), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/** Invalidate local helpers even when server-side unsettle is an idempotent no-op. */
export async function cancelDeferredSettlement(environment: string, threadId: string) {
  const path = cancellationFile({ environment, threadId });
  await NodeFSP.mkdir(NodePath.dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${NodeCrypto.randomUUID()}.tmp`;
  await NodeFSP.writeFile(temporary, NodeCrypto.randomUUID(), { mode: 0o600 });
  await NodeFSP.rename(temporary, path);
}

/** Detach only after the child acknowledges startup; keep the result in a private log. */
export async function startDeferredSettlement(request: SettlementRequest) {
  request = { ...request, cancellationToken: await cancellationToken(request) };
  const directory = NodePath.join(NodePath.dirname(resolveStateFile()), "settlements");
  await NodeFSP.mkdir(directory, { recursive: true, mode: 0o700 });
  const logPath = NodePath.join(directory, `${NodeCrypto.randomUUID()}.jsonl`);
  const log = await NodeFSP.open(logPath, "wx", 0o600);
  try {
    const child = NodeChildProcess.spawn(
      process.execPath,
      [...process.execArgv, process.argv[1]!, "settle-after-turn", JSON.stringify(request)],
      { detached: true, stdio: ["ignore", log.fd, log.fd, "ipc"] },
    );
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error(`Deferred settlement did not start; inspect ${logPath}`));
      }, 15_000);
      child.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once("exit", (code) => {
        clearTimeout(timer);
        reject(new Error(`Deferred settlement exited (${code}); inspect ${logPath}`));
      });
      child.once("message", (message) => {
        clearTimeout(timer);
        if (message !== "ready") {
          child.kill();
          reject(new Error(`Unexpected settlement startup response; inspect ${logPath}`));
          return;
        }
        child.disconnect();
        child.unref();
        resolve();
      });
    });
    return { ...request, deferred: true, pid: child.pid, logPath };
  } finally {
    await log.close();
  }
}

export function parseSettlementRequest(json: string): SettlementRequest {
  const value: unknown = JSON.parse(json);
  if (
    typeof value !== "object" ||
    value === null ||
    !("threadId" in value) ||
    typeof value.threadId !== "string" ||
    !value.threadId ||
    !("environment" in value) ||
    typeof value.environment !== "string" ||
    !value.environment ||
    !("turnId" in value) ||
    typeof value.turnId !== "string" ||
    !value.turnId ||
    !("unsettledAt" in value) ||
    (value.unsettledAt !== null && typeof value.unsettledAt !== "string")
  )
    throw new Error("Invalid deferred settlement request.");
  return {
    threadId: value.threadId,
    environment: value.environment,
    turnId: value.turnId,
    unsettledAt: value.unsettledAt,
    cancellationToken:
      "cancellationToken" in value && typeof value.cancellationToken === "string"
        ? value.cancellationToken
        : null,
  };
}

/** A separate process can outlive the agent's final reply without stopping its provider. */
export async function runDeferredSettlement(request: SettlementRequest, client: SettlementClient) {
  const timeout = setTimeout(() => {
    process.stderr.write("Deferred settlement expired after 24 hours.\n");
    process.exit(1);
  }, MAX_WAIT_MS);
  try {
    process.send?.("ready");
    const result = await settleAfterTurn(request, client, {
      isCancelled: async () =>
        (await cancellationToken(request)) !== (request.cancellationToken ?? null),
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } finally {
    clearTimeout(timeout);
  }
}
