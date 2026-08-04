// oxlint-disable t3code/no-global-process-runtime -- Standalone Electron install script has no Effect runtime.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

const require = NodeModule.createRequire(new URL("../apps/desktop/package.json", import.meta.url));
const electronPackageJsonPath = require.resolve("electron/package.json");
const electronPackageDirectory = NodePath.dirname(electronPackageJsonPath);
const electronRequire = NodeModule.createRequire(electronPackageJsonPath);
const installScriptPath = NodePath.join(electronPackageDirectory, "install.js");
const { version } = electronRequire("./package.json");

const platformPath = (() => {
  switch (process.platform) {
    case "darwin":
      return NodePath.join("Electron.app", "Contents", "MacOS", "Electron");
    case "linux":
    case "freebsd":
    case "openbsd":
      return "electron";
    case "win32":
      return "electron.exe";
    default:
      throw new Error(`Electron builds are not available on platform: ${process.platform}`);
  }
})();

const electronExecutablePath = NodePath.join(electronPackageDirectory, "dist", platformPath);
const distPath = NodePath.join(electronPackageDirectory, "dist");

const runElectronInstall = (force) => {
  const result = NodeChildProcess.spawnSync(process.execPath, [installScriptPath], {
    stdio: "inherit",
    env: {
      ...process.env,
      ELECTRON_SKIP_BINARY_DOWNLOAD: "",
      ELECTRON_OVERRIDE_DIST_PATH: "",
      npm_config_arch: process.arch,
      npm_config_platform: process.platform,
      ...(force ? { force_no_cache: "true" } : {}),
    },
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
};

const downloadAndExtractElectron = () => {
  NodeFS.rmSync(distPath, { force: true, recursive: true });
  NodeFS.rmSync(NodePath.join(electronPackageDirectory, "path.txt"), { force: true });
  NodeFS.mkdirSync(distPath, { recursive: true });

  const tempDirectory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-electron-"));
  const zipPath = NodePath.join(
    tempDirectory,
    `electron-v${version}-${process.platform}-${process.arch}.zip`,
  );
  const artifactUrl = `https://github.com/electron/electron/releases/download/v${version}/${NodePath.basename(zipPath)}`;

  for (const [command, args] of [
    [
      "curl",
      [
        "--fail",
        "--location",
        "--retry",
        "3",
        "--retry-delay",
        "2",
        "--output",
        zipPath,
        artifactUrl,
      ],
    ],
    ["unzip", ["-q", zipPath, "-d", distPath]],
  ]) {
    const result = NodeChildProcess.spawnSync(command, args, { stdio: "inherit" });
    if (result.error) {
      throw result.error;
    }
    if (result.status !== 0) {
      process.exit(result.status ?? 1);
    }
  }

  const extractedTypesPath = NodePath.join(distPath, "electron.d.ts");
  if (NodeFS.existsSync(extractedTypesPath)) {
    NodeFS.renameSync(extractedTypesPath, NodePath.join(electronPackageDirectory, "electron.d.ts"));
  }

  NodeFS.writeFileSync(NodePath.join(electronPackageDirectory, "path.txt"), platformPath);
};

runElectronInstall(false);

if (!NodeFS.existsSync(electronExecutablePath)) {
  downloadAndExtractElectron();
}

if (!NodeFS.existsSync(electronExecutablePath)) {
  const distEntries = NodeFS.existsSync(distPath)
    ? NodeFS.readdirSync(distPath).join(", ")
    : "<missing>";
  console.error(
    `Electron install did not create ${platformPath} for ${process.platform}/${process.arch}. dist contains: ${distEntries}`,
  );
  console.error(`Electron executable was not installed at ${electronExecutablePath}`);
  process.exit(1);
}

console.log(`Electron executable available at ${electronExecutablePath}`);
