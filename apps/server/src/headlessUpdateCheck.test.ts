// @effect-diagnostics globalDate:off

import * as Effect from "effect/Effect";
import { describe, expect, it, vi } from "vite-plus/test";

import { createHeadlessUpdateCheckRequester } from "./headlessUpdateCheck.ts";

describe("headlessUpdateCheck", () => {
  it("reports unsupported on non-linux platforms", async () => {
    const request = createHeadlessUpdateCheckRequester({
      platform: "darwin",
      now: () => new Date("2026-05-08T00:00:00.000Z"),
    });

    await expect(
      Effect.runPromise(request({ clientVersion: "1.0.0", serverVersion: "0.0.0" })),
    ).resolves.toMatchObject({
      status: "unsupported",
    });
  });

  it("starts the user systemd updater service on supported headless installs", async () => {
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

    await expect(
      Effect.runPromise(request({ clientVersion: "1.0.0", serverVersion: "0.0.0" })),
    ).resolves.toMatchObject({
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
  });

  it("applies cooldown after queueing a check", async () => {
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

    await expect(
      Effect.runPromise(request({ clientVersion: "1.0.0", serverVersion: "0.0.0" })),
    ).resolves.toMatchObject({
      status: "queued",
    });
    nowMs = 2_000;
    await expect(
      Effect.runPromise(request({ clientVersion: "1.0.0", serverVersion: "0.0.0" })),
    ).resolves.toMatchObject({
      status: "cooldown",
    });
  });
  it("keeps disabled installs unsupported without invoking systemd", async () => {
    const runCommand = vi.fn();
    const request = createHeadlessUpdateCheckRequester({
      platform: "linux",
      env: { T3CODE_HEADLESS_UPDATE_CHECK: "0" },
      runCommand,
    });
    expect(
      await Effect.runPromise(request({ clientVersion: "2", serverVersion: "1" })),
    ).toMatchObject({ status: "unsupported" });
    expect(runCommand).not.toHaveBeenCalled();
  });
  it("does not start duplicate concurrent checks", async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const runCommand = vi.fn(async () => {
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
    const first = Effect.runPromise(request({ clientVersion: "2", serverVersion: "1" }));
    expect(
      await Effect.runPromise(request({ clientVersion: "2", serverVersion: "1" })),
    ).toMatchObject({ status: "cooldown" });
    release();
    expect(await first).toMatchObject({ status: "queued" });
    expect(runCommand).toHaveBeenCalledTimes(1);
  });
});
