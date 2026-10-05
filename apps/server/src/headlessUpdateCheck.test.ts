// @effect-diagnostics globalDate:off

import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { describe, expect, vi } from "vite-plus/test";
import { it } from "@effect/vitest";

import { createHeadlessUpdateCheckRequester } from "./headlessUpdateCheck.ts";

describe("headlessUpdateCheck", () => {
  it.effect("reports unsupported on non-linux platforms", () =>
    Effect.gen(function* () {
      const request = createHeadlessUpdateCheckRequester({
        platform: "darwin",
        now: () => new Date("2026-05-08T00:00:00.000Z"),
      });

      expect(yield* request({ clientVersion: "1.0.0", serverVersion: "0.0.0" })).toMatchObject({
        status: "unsupported",
      });
    }),
  );

  it.effect("starts the user systemd updater service on supported headless installs", () =>
    Effect.gen(function* () {
      const runCommand = vi.fn().mockResolvedValue({
        stdout: "",
        stderr: "",
        code: 0,
        signal: null,
        timedOut: false,
      });
      const request = createHeadlessUpdateCheckRequester({
        platform: "linux",
        env: {
          HOME: "/home/brad",
        },
        getUid: () => 1000,
        existsSync: () => true,
        runCommand,
        now: () => new Date("2026-05-08T00:00:00.000Z"),
      });

      expect(yield* request({ clientVersion: "1.0.0", serverVersion: "0.0.0" })).toMatchObject({
        status: "queued",
      });
      expect(runCommand).toHaveBeenCalledWith(
        "systemctl",
        ["--user", "start", "t3code-headless-upgrade.service"],
        {
          env: {
            HOME: "/home/brad",
            XDG_RUNTIME_DIR: "/run/user/1000",
          },
          timeoutMs: 10_000,
        },
      );
    }),
  );

  it.effect("applies cooldown after queueing a check", () =>
    Effect.gen(function* () {
      let nowMs = 1_000;
      const request = createHeadlessUpdateCheckRequester({
        platform: "linux",
        existsSync: () => true,
        runCommand: vi.fn().mockResolvedValue({
          stdout: "",
          stderr: "",
          code: 0,
          signal: null,
          timedOut: false,
        }),
        now: () => new Date(nowMs),
        cooldownMs: 30_000,
      });

      expect(yield* request({ clientVersion: "1.0.0", serverVersion: "0.0.0" })).toMatchObject({
        status: "queued",
      });
      nowMs = 2_000;
      expect(yield* request({ clientVersion: "1.0.0", serverVersion: "0.0.0" })).toMatchObject({
        status: "cooldown",
      });
    }),
  );
  it.effect("keeps disabled installs unsupported without invoking systemd", () =>
    Effect.gen(function* () {
      const runCommand = vi.fn();
      const request = createHeadlessUpdateCheckRequester({
        platform: "linux",
        env: { T3CODE_HEADLESS_UPDATE_CHECK: "0" },
        runCommand,
      });
      expect(yield* request({ clientVersion: "2", serverVersion: "1" })).toMatchObject({
        status: "unsupported",
      });
      expect(runCommand).not.toHaveBeenCalled();
    }),
  );
  it.effect("does not start duplicate concurrent checks", () =>
    Effect.gen(function* () {
      let release!: () => void;
      let entered!: () => void;
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const pending = new Promise<void>((resolve) => {
        release = resolve;
      });
      const runCommand = vi.fn(async () => {
        entered();
        await pending;
        return {
          stdout: "",
          stderr: "",
          code: null,
          timedOut: false,
          stdoutTruncated: false,
          stderrTruncated: false,
          stdoutInvalidUtf8: false,
          stderrInvalidUtf8: false,
        };
      });
      const request = createHeadlessUpdateCheckRequester({
        platform: "linux",
        env: { T3CODE_HEADLESS_UPDATE_CHECK: "1" },
        runCommand,
      });
      const first = yield* request({ clientVersion: "2", serverVersion: "1" }).pipe(
        Effect.forkChild,
      );
      yield* Effect.promise(() => started);
      expect(yield* request({ clientVersion: "2", serverVersion: "1" })).toMatchObject({
        status: "cooldown",
      });
      release();
      expect(yield* Fiber.join(first)).toMatchObject({ status: "queued" });
      expect(runCommand).toHaveBeenCalledTimes(1);
    }),
  );
});
