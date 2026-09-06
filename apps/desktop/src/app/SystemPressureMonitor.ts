// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";

import * as Data from "effect/Data";
import * as Effect from "effect/Effect";

import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import { makeComponentLogger } from "./DesktopObservability.ts";
import { getDesktopOrigin } from "../electron/ElectronProtocol.ts";

const execFile = NodeUtil.promisify(NodeChildProcess.execFile);
const { logInfo, logWarning } = makeComponentLogger("system-pressure-monitor");

class SystemPressureMonitorError extends Data.TaggedError("SystemPressureMonitorError")<{
  readonly cause: unknown;
}> {}

function toError(cause: unknown): SystemPressureMonitorError {
  return new SystemPressureMonitorError({ cause });
}

export interface PressureMonitorLaunchAgentInput {
  readonly label: string;
  readonly executablePath: string;
  readonly settingsPath: string;
  readonly statePath: string;
  readonly recoveryUrl: string;
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

export function renderPressureMonitorLaunchAgent(input: PressureMonitorLaunchAgentInput): string {
  const argumentsList = [
    input.executablePath,
    "--settings-path",
    input.settingsPath,
    "--state-path",
    input.statePath,
    "--recovery-url",
    input.recoveryUrl,
  ]
    .map((argument) => `      <string>${escapeXml(argument)}</string>`)
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>${escapeXml(input.label)}</string>
    <key>ProgramArguments</key>
    <array>
${argumentsList}
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>ProcessType</key>
    <string>Background</string>
    <key>ThrottleInterval</key>
    <integer>10</integer>
    <key>StandardOutPath</key>
    <string>/dev/null</string>
    <key>StandardErrorPath</key>
    <string>/dev/null</string>
  </dict>
</plist>
`;
}

function runLaunchctl(args: ReadonlyArray<string>) {
  return Effect.tryPromise({
    try: () => execFile("/bin/launchctl", [...args]),
    catch: toError,
  });
}

function resolveMonitorExecutable(
  environment: DesktopEnvironment.DesktopEnvironment["Service"],
): string | undefined {
  const candidates = environment.isPackaged
    ? [NodePath.join(environment.resourcesPath, "T3PressureMonitor")]
    : [NodePath.join(environment.rootDir, "apps", "desktop", "resources", "T3PressureMonitor")];
  return candidates.find((candidate) => NodeFS.existsSync(candidate));
}

export function stagePressureMonitorExecutable(sourcePath: string, stateDir: string): string {
  const installDir = NodePath.join(stateDir, "pressure-monitor");
  const executablePath = NodePath.join(installDir, "T3PressureMonitor");
  if (NodePath.resolve(sourcePath) === NodePath.resolve(executablePath)) {
    return executablePath;
  }

  NodeFS.mkdirSync(installDir, { recursive: true });
  const tempPath = NodePath.join(installDir, `T3PressureMonitor.${process.pid}.tmp`);
  try {
    NodeFS.copyFileSync(sourcePath, tempPath);
    NodeFS.chmodSync(tempPath, 0o755);
    NodeFS.renameSync(tempPath, executablePath);
  } finally {
    if (NodeFS.existsSync(tempPath)) {
      NodeFS.unlinkSync(tempPath);
    }
  }
  return executablePath;
}

export const install = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  if (environment.platform !== "darwin") return;

  const sourcePath = resolveMonitorExecutable(environment);
  if (!sourcePath) {
    yield* logWarning("native pressure monitor binary is unavailable");
    return;
  }

  const label = `${environment.appUserModelId}.pressure-monitor`;
  const launchAgentsDir = NodePath.join(environment.homeDirectory, "Library", "LaunchAgents");
  const plistPath = NodePath.join(launchAgentsDir, `${label}.plist`);
  const domain = `gui/${process.getuid?.() ?? 0}`;

  const plistWritten = yield* Effect.try({
    try: () => {
      const executablePath = stagePressureMonitorExecutable(sourcePath, environment.stateDir);
      const plist = renderPressureMonitorLaunchAgent({
        label,
        executablePath,
        settingsPath: environment.serverSettingsPath,
        statePath: NodePath.join(environment.stateDir, "system-pressure.json"),
        recoveryUrl: `${getDesktopOrigin(environment.isDevelopment)}/settings/diagnostics?recovery=1`,
      });
      NodeFS.mkdirSync(launchAgentsDir, { recursive: true });
      const tempPath = `${plistPath}.${process.pid}.tmp`;
      NodeFS.writeFileSync(tempPath, plist, { mode: 0o600 });
      NodeFS.renameSync(tempPath, plistPath);
      return true;
    },
    catch: toError,
  }).pipe(
    Effect.catch((cause) =>
      logWarning("failed to write pressure monitor launch agent", {
        plistPath,
        cause,
      }).pipe(Effect.as(false)),
    ),
  );
  if (!plistWritten) return;

  yield* runLaunchctl(["bootout", domain, plistPath]).pipe(Effect.ignore);
  yield* runLaunchctl(["bootstrap", domain, plistPath]).pipe(
    Effect.tap(() => logInfo("native pressure monitor installed", { label, plistPath })),
    Effect.catch((cause) =>
      logWarning("failed to bootstrap pressure monitor launch agent", {
        label,
        plistPath,
        cause,
      }),
    ),
  );
});
