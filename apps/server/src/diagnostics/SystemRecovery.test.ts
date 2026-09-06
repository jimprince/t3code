import { describe, expect, it } from "vite-plus/test";

import { isDiagnosticCaptureCommand, isOrphanedProviderWorker } from "./SystemRecovery.ts";

describe("SystemRecovery candidate classification", () => {
  it("recognizes bounded diagnostic capture commands", () => {
    expect(isDiagnosticCaptureCommand("python3 /tmp/storm-capture.py --duration 60")).toBe(true);
    expect(isDiagnosticCaptureCommand("/usr/bin/log stream --style compact")).toBe(true);
    expect(isDiagnosticCaptureCommand("/usr/bin/spindump 123")).toBe(true);
    expect(isDiagnosticCaptureCommand("node apps/server/dist/bin.mjs")).toBe(false);
  });

  it("only treats reparented provider binaries as orphan candidates", () => {
    expect(
      isOrphanedProviderWorker({ ppid: 1, command: "/opt/homebrew/bin/codex app-server" }),
    ).toBe(true);
    expect(
      isOrphanedProviderWorker({ ppid: 42, command: "/opt/homebrew/bin/codex app-server" }),
    ).toBe(false);
    expect(isOrphanedProviderWorker({ ppid: 1, command: "/usr/bin/syspolicyd" })).toBe(false);
  });
});
