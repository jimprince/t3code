#!/usr/bin/env node
import { execFile, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const DEFAULTS = {
  backendUrl: "http://100.64.0.4:3773",
  expectedEnvironmentId: "c9d5fd19-15d1-45f1-856d-3d05a939854d",
  bundleId: "com.brad.t3code.dev",
  scheme: "t3code-brad-dev",
  metroUrl: "http://192.168.50.131:8081",
  snapshotFile: "t3-mobile-debug-snapshot.json",
  commandFile: "t3-mobile-debug-command.json",
  vmT3Bin: "/home/brad/.local/node/bin/t3",
  appBootWaitMs: 15000,
  commandWaitMs: 5000,
};

const LOCAL_NETWORK_ENV = path.join(homedir(), ".shared/config/local_network.env");

function parseEnvFile(filePath) {
  if (!existsSync(filePath)) {
    return {};
  }
  const out = {};
  for (const line of readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)\s*$/);
    if (!match) continue;
    const [, key, rawValue] = match;
    out[key] = rawValue.replace(/^["']|["']$/g, "");
  }
  return out;
}

const localEnv = parseEnvFile(LOCAL_NETWORK_ENV);

function parseBooleanEnv(value, defaultValue = false) {
  if (value === undefined) {
    return defaultValue;
  }
  return /^(1|true|yes)$/i.test(value.trim());
}

const config = {
  backendUrl:
    process.env.T3_MOBILE_DEBUG_VM_URL ?? localEnv.DESKTOP_DEV_VM_T3CODE_URL ?? DEFAULTS.backendUrl,
  expectedEnvironmentId:
    process.env.T3_MOBILE_DEBUG_EXPECTED_ENV_ID ?? DEFAULTS.expectedEnvironmentId,
  bundleId: process.env.T3_MOBILE_DEBUG_BUNDLE_ID ?? DEFAULTS.bundleId,
  scheme: process.env.T3_MOBILE_DEBUG_SCHEME ?? DEFAULTS.scheme,
  metroUrl: process.env.T3_MOBILE_DEBUG_METRO_URL ?? DEFAULTS.metroUrl,
  snapshotFile: process.env.T3_MOBILE_DEBUG_SNAPSHOT_FILE ?? DEFAULTS.snapshotFile,
  commandFile: process.env.T3_MOBILE_DEBUG_COMMAND_FILE ?? DEFAULTS.commandFile,
  vmT3Bin: process.env.T3_MOBILE_DEBUG_VM_T3_BIN ?? DEFAULTS.vmT3Bin,
  appBootWaitMs: Number(process.env.T3_MOBILE_DEBUG_APP_BOOT_WAIT_MS ?? DEFAULTS.appBootWaitMs),
  commandWaitMs: Number(process.env.T3_MOBILE_DEBUG_COMMAND_WAIT_MS ?? DEFAULTS.commandWaitMs),
  replaceExisting: parseBooleanEnv(process.env.T3_MOBILE_DEBUG_REPLACE_EXISTING, false),
  sshHost:
    process.env.T3_MOBILE_DEBUG_VM_SSH ??
    localEnv.DESKTOP_DEV_VM_TAILNET_HOST ??
    localEnv.DESKTOP_DEV_VM_TAILNET_IP ??
    localEnv.DESKTOP_DEV_VM_LAN_IP,
};

function redact(value) {
  return String(value).replace(/(token=)[^&#\s]+/gi, "$1[redacted]");
}

async function run(command, args, options = {}) {
  try {
    const result = await execFileAsync(command, args, {
      maxBuffer: 10 * 1024 * 1024,
      ...options,
    });
    return result.stdout.trim();
  } catch (error) {
    const stderr = error.stderr?.trim();
    const stdout = error.stdout?.trim();
    throw new Error(
      [
        `${command} ${args.join(" ")} failed`,
        stdout ? `stdout:\n${redact(stdout)}` : "",
        stderr ? `stderr:\n${redact(stderr)}` : "",
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }
}

async function resolveDeviceId() {
  if (process.env.T3_MOBILE_DEBUG_DEVICE_ID) {
    return process.env.T3_MOBILE_DEBUG_DEVICE_ID;
  }
  const output = await run("xcrun", ["devicectl", "list", "devices"]);
  const match = output.match(/([0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12})/i);
  if (!match) {
    throw new Error("No CoreDevice identifier found. Connect and trust the iPhone first.");
  }
  return match[1];
}

async function verifyVmDescriptor() {
  const response = await fetch(
    `${config.backendUrl.replace(/\/$/, "")}/.well-known/t3/environment`,
  );
  if (!response.ok) {
    throw new Error(`VM descriptor request failed with HTTP ${response.status}.`);
  }
  const descriptor = await response.json();
  if (descriptor.environmentId !== config.expectedEnvironmentId) {
    throw new Error(
      `VM environment mismatch: expected ${config.expectedEnvironmentId}, got ${descriptor.environmentId}.`,
    );
  }
  console.log(`VM: ${config.backendUrl} reachable (${descriptor.label})`);
}

async function verifyVmService() {
  if (!config.sshHost) {
    console.log("VM SSH: skipped; no SSH host configured");
    return;
  }
  const status = await run("ssh", [config.sshHost, "systemctl", "is-active", "t3code.service"]);
  if (status !== "active") {
    throw new Error(`VM service is not active: ${status}`);
  }
  console.log("VM service: active");
}

async function verifyMetro() {
  try {
    const response = await fetch(`${config.metroUrl.replace(/\/$/, "")}/status`);
    const text = await response.text();
    if (!response.ok || !/packager-status:running/i.test(text)) {
      throw new Error(`unexpected Metro status: HTTP ${response.status} ${text.trim()}`);
    }
    console.log(`Metro: running at ${config.metroUrl}`);
  } catch (error) {
    throw new Error(
      `Metro is not reachable at ${config.metroUrl}. Start it with APP_VARIANT=development bunx expo start --dev-client --clear. ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

async function createPairingUrl() {
  if (process.env.T3_MOBILE_DEBUG_PAIRING_URL) {
    return process.env.T3_MOBILE_DEBUG_PAIRING_URL;
  }
  if (!config.sshHost) {
    throw new Error("Cannot create pairing URL: no VM SSH host configured.");
  }
  const command = [
    "PATH=/home/brad/.local/node/bin:$PATH",
    config.vmT3Bin,
    "auth",
    "pairing",
    "create",
    "--base-dir",
    "~/.local/share/t3code-dev",
    "--base-url",
    JSON.stringify(config.backendUrl),
    "--label",
    "ios-debug",
    "--ttl",
    "15m",
    "--json",
  ].join(" ");
  const raw = await run("ssh", [config.sshHost, command]);
  const parsed = JSON.parse(raw);
  const pairingUrl = parsed.pairingUrl ?? parsed.pairUrl ?? parsed.url;
  if (!pairingUrl) {
    throw new Error("Pairing command did not return pairingUrl.");
  }
  console.log("Pairing: created fresh 15m token");
  return pairingUrl;
}

async function launchUrl(deviceId, url, options = {}) {
  await run("xcrun", [
    "devicectl",
    "device",
    "process",
    "launch",
    "--device",
    deviceId,
    ...(options.terminateExisting ? ["--terminate-existing"] : []),
    "--payload-url",
    url,
    config.bundleId,
  ]);
}

async function launchDevClient(deviceId) {
  const url = `${config.scheme}://expo-development-client/?url=${encodeURIComponent(config.metroUrl)}`;
  await launchUrl(deviceId, url, { terminateExisting: true });
  console.log(`App: launched dev client (${config.bundleId})`);
}

async function sendDebugCommand(deviceId, url) {
  const source = path.join(tmpdir(), `t3-mobile-debug-command-${Date.now()}.json`);
  await writeFile(
    source,
    `${JSON.stringify(
      {
        id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
        url,
      },
      null,
      2,
    )}\n`,
  );
  await run("xcrun", [
    "devicectl",
    "device",
    "copy",
    "to",
    "--device",
    deviceId,
    "--domain-type",
    "appDataContainer",
    "--domain-identifier",
    config.bundleId,
    "--source",
    source,
    "--destination",
    `Documents/${config.commandFile}`,
  ]);
}

async function copySnapshot(deviceId) {
  const destinationDir = path.join(tmpdir(), "t3-mobile-debug");
  await mkdir(destinationDir, { recursive: true });
  const destination = path.join(destinationDir, config.snapshotFile);
  await run("xcrun", [
    "devicectl",
    "device",
    "copy",
    "from",
    "--device",
    deviceId,
    "--domain-type",
    "appDataContainer",
    "--domain-identifier",
    config.bundleId,
    "--source",
    `Documents/${config.snapshotFile}`,
    "--destination",
    destination,
  ]);
  return destination;
}

async function requestDump(deviceId) {
  await sendDebugCommand(deviceId, `${config.scheme}://debug/dump`);
  await new Promise((resolve) => setTimeout(resolve, config.commandWaitMs));
  const snapshotPath = await copySnapshot(deviceId);
  const snapshot = JSON.parse(await readFile(snapshotPath, "utf8"));
  return { snapshotPath, snapshot };
}

function verifySnapshot(snapshot) {
  const savedConnections = snapshot.savedConnections ?? [];
  if (config.replaceExisting && savedConnections.length !== 1) {
    throw new Error(
      `Expected exactly one saved connection after replacement, found ${savedConnections.length}.`,
    );
  }
  const connection = savedConnections.find(
    (entry) => entry.environmentId === config.expectedEnvironmentId,
  );
  if (!connection) {
    throw new Error(
      `Expected VM environment ${config.expectedEnvironmentId}, found ${savedConnections.length} saved connection(s).`,
    );
  }
  if (connection.environmentId !== config.expectedEnvironmentId) {
    throw new Error(
      `Expected VM environment ${config.expectedEnvironmentId}, found ${connection.environmentId}.`,
    );
  }
  const runtime = (snapshot.runtime ?? []).find(
    (entry) => entry.environmentId === config.expectedEnvironmentId,
  );
  if (!runtime) {
    throw new Error("Snapshot does not include VM runtime state.");
  }
  if (runtime.state !== "ready") {
    throw new Error(`VM runtime is ${runtime.state}: ${runtime.error ?? "no error recorded"}`);
  }
  if (!runtime.shellSnapshotLoaded) {
    throw new Error(`VM shell snapshot has not loaded: ${runtime.shellSnapshotError ?? "pending"}`);
  }
  const fatalDiagnostic = (snapshot.diagnosticsTail ?? []).find((event) =>
    /schema|decode|mobile\.ws\.error|mobile\.rpc\.subscribe\.shell\.error/i.test(event.tag),
  );
  if (fatalDiagnostic) {
    throw new Error(
      `Recent fatal diagnostic: ${fatalDiagnostic.tag} ${fatalDiagnostic.message ?? ""}`.trim(),
    );
  }
  if (runtime.threadCount === 0) {
    console.log("Connected to VM, shell snapshot loaded, but threadCount=0.");
  }
  console.log(`Connection: ready`);
  console.log(`Projects: ${runtime.projectCount}`);
  console.log(`Threads: ${runtime.threadCount}`);
}

async function pairVm() {
  const deviceId = await resolveDeviceId();
  console.log(`Device: ${deviceId}`);
  await verifyVmDescriptor();
  await verifyVmService();
  await verifyMetro();
  await launchDevClient(deviceId);
  await new Promise((resolve) => setTimeout(resolve, config.appBootWaitMs));
  const pairingUrl = await createPairingUrl();
  const replaceQuery = config.replaceExisting ? "&replace=1" : "";
  const debugUrl = `${config.scheme}://debug/pair?pairingUrl=${encodeURIComponent(pairingUrl)}${replaceQuery}`;
  await sendDebugCommand(deviceId, debugUrl);
  console.log(
    `App: pairing command sent (${config.replaceExisting ? "replace existing backends" : "preserve existing backends"})`,
  );
  await new Promise((resolve) => setTimeout(resolve, config.commandWaitMs));
  const { snapshotPath, snapshot } = await requestDump(deviceId);
  verifySnapshot(snapshot);
  console.log(`Debug dump: ${snapshotPath}`);
}

async function clear() {
  const deviceId = await resolveDeviceId();
  await sendDebugCommand(deviceId, `${config.scheme}://debug/clear-connections`);
  console.log("App: clear-connections command sent");
}

async function dump() {
  const deviceId = await resolveDeviceId();
  const { snapshotPath, snapshot } = await requestDump(deviceId);
  console.log(`Debug dump: ${snapshotPath}`);
  console.log(
    JSON.stringify(
      {
        app: snapshot.app,
        savedConnectionCount: snapshot.savedConnections?.length ?? 0,
        runtime: snapshot.runtime,
      },
      null,
      2,
    ),
  );
}

async function logs() {
  const outputPath = path.join(tmpdir(), `t3-mobile-ios-${Date.now()}.log`);
  const child = spawn("idevicesyslog", ["-n", "T3CodeDev"], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  const chunks = [];
  child.stdout.on("data", (chunk) => {
    process.stdout.write(chunk);
    chunks.push(chunk);
  });
  child.stderr.pipe(process.stderr);
  process.on("SIGINT", async () => {
    child.kill("SIGINT");
    await writeFile(outputPath, Buffer.concat(chunks));
    console.log(`\nLogs: ${outputPath}`);
    process.exit(0);
  });
}

const command = process.argv[2];

try {
  switch (command) {
    case "pair-vm":
      await pairVm();
      break;
    case "dump":
      await dump();
      break;
    case "clear":
      await clear();
      break;
    case "logs":
      await logs();
      break;
    default:
      console.error("Usage: ios-debug-control.mjs <pair-vm|dump|clear|logs>");
      process.exit(2);
  }
} catch (error) {
  console.error(redact(error instanceof Error ? (error.stack ?? error.message) : String(error)));
  process.exit(1);
}
