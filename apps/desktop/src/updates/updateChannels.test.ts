import { describe, expect, it } from "vite-plus/test";

import { isNightlyDesktopVersion, resolveDefaultDesktopUpdateChannel } from "./updateChannels.ts";

describe("updateChannels", () => {
  it("keeps preview builds branded as nightly but on the latest update channel", () => {
    expect(isNightlyDesktopVersion("0.0.41-preview.20260911.7")).toBe(true);
    expect(resolveDefaultDesktopUpdateChannel("0.0.41-preview.20260911.7")).toBe("latest");
    expect(resolveDefaultDesktopUpdateChannel("0.0.41-nightly.20260911.7")).toBe("nightly");
  });

  it("only matches the first prerelease identifier", () => {
    expect(isNightlyDesktopVersion("1.2.3-foo-preview.20260911.1")).toBe(false);
    expect(isNightlyDesktopVersion("1.2.3")).toBe(false);
  });

  it("detects packaged nightly versions", () => {
    expect(isNightlyDesktopVersion("0.0.17-nightly.20260415.1")).toBe(true);
  });

  it("detects fork-published nightly versions", () => {
    expect(isNightlyDesktopVersion("0.0.21-nightly.20260421.88-fork.1")).toBe(true);
    expect(isNightlyDesktopVersion("0.0.22-nightly.20260423.108-fork.2")).toBe(true);
  });

  it("does not flag stable versions as nightly", () => {
    expect(isNightlyDesktopVersion("0.0.17")).toBe(false);
  });

  it("does not flag stable fork-interim versions as nightly", () => {
    expect(isNightlyDesktopVersion("0.0.22-fork.1")).toBe(false);
  });
});

describe("resolveDefaultDesktopUpdateChannel", () => {
  it("defaults stable builds to latest", () => {
    expect(resolveDefaultDesktopUpdateChannel("0.0.17")).toBe("latest");
  });

  it("defaults nightly builds to nightly", () => {
    expect(resolveDefaultDesktopUpdateChannel("0.0.17-nightly.20260415.1")).toBe("nightly");
  });

  it("defaults fork-published nightly builds to nightly", () => {
    expect(resolveDefaultDesktopUpdateChannel("0.0.21-nightly.20260421.88-fork.1")).toBe("nightly");
  });
});
