import { type ChildProcessWithoutNullStreams, spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { Buffer } from "node:buffer";
import readline from "node:readline";
import path from "node:path";

import { createOpencodeClient } from "@opencode-ai/sdk/v2/client";
import { Effect, Layer, PubSub, Stream } from "effect";

import { ProviderAdapterProcessError, ProviderAdapterRequestError } from "../Errors.ts";
import { toOpenCodeProviderCatalog } from "../opencodeEventMapping.ts";
import {
  OpenCodeServerPool,
  type OpenCodeServerLease,
  type OpenCodeServerPoolEvent,
  type OpenCodeServerPoolShape,
} from "../Services/OpenCodeServerPool.ts";

const PROVIDER = "opencode" as const;
const DEFAULT_BINARY_PATH = "opencode";
const DEFAULT_START_TIMEOUT_MS = 20_000;
const LISTENING_LINE_PREFIX = "opencode server listening on ";
const OPEN_CODE_USERNAME = "t3code";

interface RunningSidecar {
  readonly key: string;
  readonly poolRoot: string;
  readonly cwd: string;
  readonly baseUrl: string;
  readonly binaryPath: string;
  readonly authHeader: string;
  readonly child: ChildProcessWithoutNullStreams;
  readonly stdout: readline.Interface;
}

interface PoolEntry {
  readonly key: string;
  readonly poolRoot: string;
  readonly cwd: string;
  readonly binaryPath: string;
  ready: Promise<RunningSidecar>;
  refs: number;
  running?: RunningSidecar;
  stopping: boolean;
}

function buildAuthHeader(password: string): string {
  const token = Buffer.from(`${OPEN_CODE_USERNAME}:${password}`, "utf8").toString("base64");
  return `Basic ${token}`;
}

function createClient(input: {
  readonly baseUrl: string;
  readonly cwd: string;
  readonly authHeader: string;
}) {
  return createOpencodeClient({
    baseUrl: input.baseUrl,
    directory: input.cwd,
    headers: {
      Authorization: input.authHeader,
    },
  });
}

function toProcessError(input: { readonly detail: string; readonly cause?: unknown }) {
  return new ProviderAdapterProcessError({
    provider: PROVIDER,
    threadId: "_pool",
    detail: input.detail,
    ...(input.cause !== undefined ? { cause: input.cause } : {}),
  });
}

function toRequestError(method: string, detail: string, cause?: unknown) {
  return new ProviderAdapterRequestError({
    provider: PROVIDER,
    method,
    detail,
    ...(cause !== undefined ? { cause } : {}),
  });
}

function killChildTree(child: ChildProcessWithoutNullStreams): void {
  if (process.platform === "win32" && child.pid !== undefined) {
    try {
      spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
      return;
    } catch {
      // Fall through to direct kill.
    }
  }

  child.kill();
}

const makeOpenCodeServerPool = Effect.gen(function* () {
  const services = yield* Effect.services<never>();
  const runPromise = Effect.runPromiseWith(services);
  const events = yield* PubSub.unbounded<OpenCodeServerPoolEvent>();
  const entries = new Map<string, PoolEntry>();

  const publishExitEvent = (input: Omit<OpenCodeServerPoolEvent, "type">) =>
    PubSub.publish(events, {
      type: "sidecar.exited",
      ...input,
    } satisfies OpenCodeServerPoolEvent);

  const stopEntry = (entry: PoolEntry, expected: boolean) =>
    Effect.promise(async () => {
      entry.stopping = true;
      const running = entry.running ?? (await entry.ready.catch(() => undefined));
      if (!running) {
        entries.delete(entry.key);
        return;
      }

      entries.delete(entry.key);
      running.stdout.close();
      if (!running.child.killed) {
        killChildTree(running.child);
      }

      await runPromise(
        publishExitEvent({
          key: running.key,
          poolRoot: running.poolRoot,
          cwd: running.cwd,
          baseUrl: running.baseUrl,
          expected,
        }),
      );
    });

  const spawnSidecar = (input: {
    readonly key: string;
    readonly poolRoot: string;
    readonly cwd: string;
    readonly binaryPath: string;
  }): Promise<RunningSidecar> =>
    new Promise((resolve, reject) => {
      const password = randomUUID();
      const authHeader = buildAuthHeader(password);
      const child = spawn(input.binaryPath, ["serve", "--hostname", "127.0.0.1", "--port", "0"], {
        cwd: input.poolRoot,
        env: {
          ...process.env,
          OPENCODE_SERVER_USERNAME: OPEN_CODE_USERNAME,
          OPENCODE_SERVER_PASSWORD: password,
        },
        stdio: ["pipe", "pipe", "pipe"],
        shell: process.platform === "win32",
      });

      const stdout = readline.createInterface({ input: child.stdout });
      const stderrLines: string[] = [];
      let settled = false;

      const finish = (result: RunningSidecar | Error, isError: boolean) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        child.removeAllListeners("error");
        child.removeAllListeners("exit");
        stdout.removeAllListeners("line");
        if (isError) {
          stdout.close();
          if (!child.killed) {
            killChildTree(child);
          }
          reject(result);
          return;
        }
        resolve(result as RunningSidecar);
      };

      const timeout = setTimeout(() => {
        const detail =
          stderrLines.at(-1) ?? "Timed out while waiting for OpenCode sidecar startup.";
        finish(new Error(detail), true);
      }, DEFAULT_START_TIMEOUT_MS);

      stdout.on("line", (line) => {
        const trimmed = line.trim();
        if (!trimmed.startsWith(LISTENING_LINE_PREFIX)) {
          return;
        }
        const baseUrl = trimmed.slice(LISTENING_LINE_PREFIX.length).trim();
        if (!baseUrl) {
          finish(new Error("OpenCode sidecar reported a malformed listening URL."), true);
          return;
        }

        finish(
          {
            key: input.key,
            poolRoot: input.poolRoot,
            cwd: input.cwd,
            baseUrl,
            binaryPath: input.binaryPath,
            authHeader,
            child,
            stdout,
          },
          false,
        );
      });

      child.stderr.on("data", (chunk: Buffer) => {
        stderrLines.push(chunk.toString("utf8").trim());
      });

      child.on("error", (error) => {
        finish(error, true);
      });

      child.on("exit", (code, signal) => {
        if (!settled) {
          const stderr = stderrLines.filter(Boolean).join("\n");
          const suffix = stderr.length > 0 ? ` ${stderr}` : "";
          finish(
            new Error(
              `OpenCode sidecar exited before it became ready (code=${code ?? "null"}, signal=${signal ?? "null"}).${suffix}`,
            ),
            true,
          );
          return;
        }

        const entry = entries.get(input.key);
        if (!entry) {
          return;
        }

        const expected = entry.stopping;
        const baseUrl = entry.running?.baseUrl ?? "unknown";
        delete entry.running;
        entries.delete(input.key);
        void runPromise(
          publishExitEvent({
            key: input.key,
            poolRoot: input.poolRoot,
            cwd: input.cwd,
            baseUrl,
            expected,
            detail: `code=${code ?? "null"}, signal=${signal ?? "null"}`,
          }),
        );
      });
    });

  const acquire: OpenCodeServerPoolShape["acquire"] = (input) =>
    Effect.tryPromise({
      try: async () => {
        const cwd = path.resolve(input.cwd);
        const poolRoot = path.resolve(input.poolRoot?.trim() || cwd);
        const binaryPath = input.binaryPath?.trim() || DEFAULT_BINARY_PATH;
        const key = `${poolRoot}::${binaryPath}`;

        let entry = entries.get(key);
        if (!entry) {
          entry = {
            key,
            poolRoot,
            cwd,
            binaryPath,
            ready: spawnSidecar({
              key,
              poolRoot,
              cwd,
              binaryPath,
            }),
            refs: 0,
            stopping: false,
          };
          entries.set(key, entry);
          entry.ready
            .then((running) => {
              const current = entries.get(key);
              if (!current) {
                running.stdout.close();
                if (!running.child.killed) {
                  killChildTree(running.child);
                }
                return;
              }
              current.running = running;
            })
            .catch(() => {
              entries.delete(key);
            });
        }

        entry.refs += 1;
        const running = await entry.ready;
        let released = false;

        return {
          key,
          poolRoot,
          cwd,
          baseUrl: running.baseUrl,
          client: createClient({
            baseUrl: running.baseUrl,
            cwd,
            authHeader: running.authHeader,
          }),
          release: Effect.promise(async () => {
            if (released) {
              return;
            }
            released = true;
            const current = entries.get(key);
            if (!current) {
              return;
            }
            current.refs = Math.max(0, current.refs - 1);
            if (current.refs === 0) {
              await runPromise(stopEntry(current, true));
            }
          }),
        } satisfies OpenCodeServerLease;
      },
      catch: (cause) =>
        toProcessError({
          detail:
            cause instanceof Error
              ? cause.message
              : "Failed to start or acquire the OpenCode sidecar.",
          cause,
        }),
    });

  const loadProviderCatalog: OpenCodeServerPoolShape["loadProviderCatalog"] = (input) =>
    Effect.gen(function* () {
      const lease = yield* acquire(input);
      try {
        const providers = yield* Effect.tryPromise({
          try: () =>
            lease.client.config
              .providers(undefined, { throwOnError: true })
              .then((result) => result.data),
          catch: (cause) =>
            toRequestError(
              "config.providers",
              cause instanceof Error ? cause.message : "Failed to load OpenCode provider catalog.",
              cause,
            ),
        });

        return toOpenCodeProviderCatalog({
          providers: providers.providers,
          defaultByProvider: providers.default,
        });
      } finally {
        yield* lease.release;
      }
    });

  const stopAll: OpenCodeServerPoolShape["stopAll"] = () =>
    Effect.forEach(Array.from(entries.values()), (entry) => stopEntry(entry, true), {
      concurrency: "unbounded",
    }).pipe(Effect.asVoid);

  return {
    acquire,
    loadProviderCatalog,
    stopAll,
    streamEvents: Stream.fromPubSub(events),
  } satisfies OpenCodeServerPoolShape;
});

export const OpenCodeServerPoolLive = Layer.effect(OpenCodeServerPool, makeOpenCodeServerPool);
