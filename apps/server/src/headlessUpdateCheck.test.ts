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
});
