import * as NodeTimersPromises from "node:timers/promises";
import * as Socket from "effect/unstable/socket/Socket";
import { resolveWebSocketUrl } from "./http.js";
import { T3RpcClient } from "./rpc.js";

const TRANSIENT_CODES = new Set(["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "EPIPE", "EAI_AGAIN"]);

/** Only used before RPC admission; the same timeout tag after a write is ambiguous. */
export function isRetryableOpenFailure(error: unknown): boolean {
  if (error instanceof Socket.SocketError) {
    return (
      error.reason._tag === "SocketOpenError" ||
      (error.reason._tag === "SocketCloseError" && error.reason.code === 1006)
    );
  }
  // Ticket fetch network failures retain their typed OS cause. HTTP/auth errors do not.
  if (error instanceof Error && "code" in error && typeof error.code === "string") {
    return TRANSIENT_CODES.has(error.code);
  }
  return error instanceof Error && error.cause !== undefined && isRetryableOpenFailure(error.cause);
}

type OpenClient = Pick<T3RpcClient, "awaitOpen" | "dispose">;

/** Four fresh attempts within one deadline. This function never sends an RPC. */
type Environment = { httpBaseUrl: string; wsBaseUrl: string; bearerToken: string };
type OpenOptions<T extends OpenClient> = {
  resolveUrl?: typeof resolveWebSocketUrl;
  prepare?: (signal: AbortSignal) => Promise<Environment>;
  createClient: (url: string) => T;
  random?: () => number;
  delay?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
};

export function openRpcConnection<T extends OpenClient>(
  environment: Environment,
  options: OpenOptions<T>,
): Promise<T>;
export function openRpcConnection(
  environment: Environment,
  options?: Omit<OpenOptions<T3RpcClient>, "createClient">,
): Promise<T3RpcClient>;
export async function openRpcConnection(
  environment: Environment,
  options: Partial<OpenOptions<OpenClient>> = {},
): Promise<OpenClient> {
  const deadline = AbortSignal.timeout(60_000);
  const delay =
    options.delay ??
    ((milliseconds, signal) => NodeTimersPromises.setTimeout(milliseconds, undefined, { signal }));
  const resolveUrl = options.resolveUrl ?? resolveWebSocketUrl;
  const current = options.prepare ? await options.prepare(deadline) : environment;
  const createClient = options.createClient ?? ((url: string) => new T3RpcClient(url));
  for (let attempt = 0; ; attempt++) {
    deadline.throwIfAborted();
    let client: OpenClient | undefined;
    try {
      // Tickets are single-use, so even a timeout must obtain a new ticket.
      const url = await resolveUrl({ ...current, signal: deadline });
      deadline.throwIfAborted();
      client = createClient(url);
      await client.awaitOpen(deadline);
      deadline.throwIfAborted();
      return client;
    } catch (error) {
      if (client) await client.dispose();
      if (deadline.aborted) throw deadline.reason;
      if (attempt === 3 || !isRetryableOpenFailure(error)) throw error;
      const jitter = 0.8 + (options.random ?? Math.random)() * 0.4;
      await delay(1000 * 2 ** attempt * jitter, deadline);
    }
  }
}
