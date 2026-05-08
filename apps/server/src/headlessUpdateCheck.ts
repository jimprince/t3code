import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { Effect } from "effect";
import type {
  ServerHeadlessUpdateCheckInput,
  ServerHeadlessUpdateCheckResult,
} from "@t3tools/contracts";

import { runProcess, type ProcessRunResult } from "./processRunner.ts";

const DEFAULT_COOLDOWN_MS = 30 * 60 * 1000;
const DEFAULT_SERVICE_NAME = "t3code-headless-upgrade.service";
const DISABLE_VALUES = new Set(["0", "false", "no", "off"]);

interface HeadlessUpdateCheckDeps {
  readonly platform?: NodeJS.Platform;
  readonly env?: NodeJS.ProcessEnv;
  readonly now?: () => Date;
  readonly existsSync?: (filePath: string) => boolean;
  readonly runCommand?: (
    command: string,
    args: readonly string[],
    options: { readonly env: NodeJS.ProcessEnv; readonly timeoutMs: number },
  ) => Promise<ProcessRunResult>;
  readonly getUid?: () => number | undefined;
  readonly cooldownMs?: number;
}

export function resolveHeadlessUpdateServicePath(env: NodeJS.ProcessEnv = process.env): string {
  return (
    env.T3CODE_HEADLESS_UPDATE_SERVICE_FILE ??
    path.join(os.homedir(), ".config/systemd/user", resolveHeadlessUpdateServiceName(env))
  );
}

export function resolveHeadlessUpdateServiceName(env: NodeJS.ProcessEnv = process.env): string {
  return env.T3CODE_HEADLESS_UPDATE_SERVICE ?? DEFAULT_SERVICE_NAME;
}

function isDisabled(value: string | undefined): boolean {
  return value !== undefined && DISABLE_VALUES.has(value.trim().toLowerCase());
}

function toIsoNow(now: () => Date): string {
  return now().toISOString();
}

function normalizeErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message.trim();
  }
  return "Failed to request a headless server update check.";
}

function makeResult(
  status: ServerHeadlessUpdateCheckResult["status"],
  checkedAt: string,
  message: string | null,
): ServerHeadlessUpdateCheckResult {
  return {
    status,
    checkedAt,
    message,
  };
}

function buildCommandEnvironment(
  env: NodeJS.ProcessEnv,
  getUid: () => number | undefined,
): NodeJS.ProcessEnv {
  const uid = getUid();
  return {
    ...env,
    XDG_RUNTIME_DIR: env.XDG_RUNTIME_DIR ?? (uid === undefined ? undefined : `/run/user/${uid}`),
  };
}

export function createHeadlessUpdateCheckRequester(deps: HeadlessUpdateCheckDeps = {}) {
  const platform = deps.platform ?? process.platform;
  const env = deps.env ?? process.env;
  const now = deps.now ?? (() => new Date());
  const existsSync = deps.existsSync ?? fs.existsSync;
  const runCommand =
    deps.runCommand ??
    ((command, args, options) =>
      runProcess(command, args, {
        env: options.env,
        timeoutMs: options.timeoutMs,
        allowNonZeroExit: false,
        outputMode: "truncate",
        maxBufferBytes: 16 * 1024,
      }));
  const getUid = deps.getUid ?? (() => process.getuid?.());
  const cooldownMs = deps.cooldownMs ?? DEFAULT_COOLDOWN_MS;
  let lastStartedAt = Number.NEGATIVE_INFINITY;

  return (input: ServerHeadlessUpdateCheckInput): Effect.Effect<ServerHeadlessUpdateCheckResult> =>
    Effect.tryPromise(async () => {
      const checkedAt = toIsoNow(now);

      if (platform !== "linux" || isDisabled(env.T3CODE_HEADLESS_UPDATE_CHECK)) {
        return makeResult(
          "unsupported",
          checkedAt,
          "Headless update checks are only supported on Linux headless installs.",
        );
      }

      const servicePath = resolveHeadlessUpdateServicePath(env);
      if (env.T3CODE_HEADLESS_UPDATE_CHECK !== "1" && !existsSync(servicePath)) {
        return makeResult(
          "unsupported",
          checkedAt,
          "No headless update systemd service is installed.",
        );
      }

      const currentTime = now().getTime();
      if (currentTime - lastStartedAt < cooldownMs) {
        return makeResult("cooldown", checkedAt, "A headless update check was requested recently.");
      }

      try {
        await runCommand("systemctl", ["--user", "start", resolveHeadlessUpdateServiceName(env)], {
          env: buildCommandEnvironment(env, getUid),
          timeoutMs: 10_000,
        });
        lastStartedAt = currentTime;
        return makeResult(
          "queued",
          checkedAt,
          `Queued headless update check because client ${input.clientVersion} is newer than server ${input.serverVersion}.`,
        );
      } catch (error) {
        return makeResult("error", checkedAt, normalizeErrorMessage(error));
      }
    }).pipe(Effect.orDie);
}

export const requestHeadlessUpdateCheck = createHeadlessUpdateCheckRequester();
