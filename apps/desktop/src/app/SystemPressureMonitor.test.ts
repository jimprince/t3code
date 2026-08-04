// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

import {
  renderPressureMonitorLaunchAgent,
  stagePressureMonitorExecutable,
} from "./SystemPressureMonitor.ts";

describe("SystemPressureMonitor", () => {
  it("renders a keep-alive native helper with explicit settings, state, and recovery paths", () => {
    const plist = renderPressureMonitorLaunchAgent({
      label: "com.t3tools.t3code.pressure-monitor",
      executablePath: "/Applications/T3 & Code/T3PressureMonitor",
      settingsPath: "/Users/test/.t3/userdata/settings.json",
      statePath: "/Users/test/.t3/userdata/system-pressure.json",
      recoveryUrl: "t3code://app/settings/diagnostics?recovery=1",
    });

    expect(plist).toContain("<key>KeepAlive</key>");
    expect(plist).toContain("<key>RunAtLoad</key>");
    expect(plist).toContain("/Applications/T3 &amp; Code/T3PressureMonitor");
    expect(plist).toContain("--settings-path");
    expect(plist).toContain("--state-path");
    expect(plist).toContain("t3code://app/settings/diagnostics?recovery=1");
    expect(plist).not.toContain("python");
    expect(plist).not.toContain("log stream");
  });

  it("stages the helper atomically under the stable application state directory", () => {
    const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-pressure-monitor-test-"));
    try {
      const sourcePath = NodePath.join(tempDir, "source-helper");
      const stateDir = NodePath.join(tempDir, "state");
      NodeFS.writeFileSync(sourcePath, "native-helper");

      const executablePath = stagePressureMonitorExecutable(sourcePath, stateDir);

      expect(executablePath).toBe(NodePath.join(stateDir, "pressure-monitor", "T3PressureMonitor"));
      expect(NodeFS.readFileSync(executablePath, "utf8")).toBe("native-helper");
      expect(NodeFS.statSync(executablePath).mode & 0o777).toBe(0o755);
      expect(NodeFS.readdirSync(NodePath.dirname(executablePath))).toEqual(["T3PressureMonitor"]);
    } finally {
      NodeFS.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
