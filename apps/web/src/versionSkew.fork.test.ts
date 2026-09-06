import { describe, expect, it, vi } from "vite-plus/test";

const branding = vi.hoisted(() => ({ APP_VERSION: "0.0.34" }));
vi.mock("./branding", () => branding);

import { APP_VERSION } from "./branding";
import { compareT3Versions, isClientVersionNewerThanServer } from "./versionSkew";

describe("versionSkew", () => {
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
