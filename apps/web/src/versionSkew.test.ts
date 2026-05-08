import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import { APP_VERSION } from "./branding";
import {
  appendVersionMismatchHint,
  buildVersionMismatchDismissalKey,
  compareT3Versions,
  dismissVersionMismatch,
  isClientVersionNewerThanServer,
  isVersionMismatchDismissed,
  resolveServerConfigVersionMismatch,
  resolveVersionMismatch,
} from "./versionSkew";

describe("versionSkew", () => {
  it("does not warn when versions match", () => {
    expect(resolveVersionMismatch(APP_VERSION)).toBeNull();
  });

  it("returns a mismatch when the server version differs from the client", () => {
    expect(resolveVersionMismatch("9.9.9")).toEqual({
      clientVersion: APP_VERSION,
      serverVersion: "9.9.9",
      hint: "Version mismatch. Try syncing the client and server to the same T3 Code version.",
    });
  });

  it("reads the server version from config descriptors", () => {
    expect(
      resolveServerConfigVersionMismatch({
        environment: {
          environmentId: EnvironmentId.make("environment-1"),
          label: "Remote",
          platform: {
            os: "darwin",
            arch: "arm64",
          },
          serverVersion: "9.9.9",
          capabilities: {
            repositoryIdentity: true,
          },
        },
      }),
    ).toMatchObject({
      serverVersion: "9.9.9",
    });
  });

  it("keys dismissals by environment, client version, and server version", () => {
    const environmentId = EnvironmentId.make("environment-dismissal");
    const key = buildVersionMismatchDismissalKey(environmentId, {
      clientVersion: APP_VERSION,
      serverVersion: "9.9.9",
    });

    expect(key).toBe(`${environmentId}:${APP_VERSION}:9.9.9`);
    expect(isVersionMismatchDismissed(key)).toBe(false);

    dismissVersionMismatch(key);

    expect(isVersionMismatchDismissed(key)).toBe(true);
    expect(
      isVersionMismatchDismissed(
        buildVersionMismatchDismissalKey(environmentId, {
          clientVersion: APP_VERSION,
          serverVersion: "9.9.10",
        }),
      ),
    ).toBe(false);
  });

  it("appends a hint to connection errors when versions differ", () => {
    const mismatch = resolveVersionMismatch("9.9.9");

    expect(appendVersionMismatchHint("Socket closed.", mismatch)).toBe(
      "Socket closed. Hint: Version mismatch. Try syncing the client and server to the same T3 Code version.",
    );
  });

  it("orders fork and nightly versions for supersedence checks", () => {
    expect(compareT3Versions("0.0.23-fork.5", "0.0.23-fork.4")).toBeGreaterThan(0);
    expect(compareT3Versions("0.0.24", "0.0.23-fork.9")).toBeGreaterThan(0);
    expect(
      compareT3Versions("0.0.23-nightly.20260508.220-fork.1", "0.0.23-fork.4"),
    ).toBeGreaterThan(0);
    expect(compareT3Versions("0.0.23-fork.4", "0.0.23-fork.5")).toBeLessThan(0);
  });

  it("detects when this client is newer than the server", () => {
    expect(isClientVersionNewerThanServer(APP_VERSION)).toBe(false);
    expect(isClientVersionNewerThanServer("0.0.0")).toBe(true);
    expect(isClientVersionNewerThanServer("999.0.0")).toBe(false);
  });
});
