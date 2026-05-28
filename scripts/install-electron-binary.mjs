import { spawnSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(new URL("../apps/desktop/package.json", import.meta.url));
const electronPackageJsonPath = require.resolve("electron/package.json");
const electronPackageDirectory = path.dirname(electronPackageJsonPath);
const installScriptPath = path.join(electronPackageDirectory, "install.js");

const platformPath = (() => {
  switch (process.platform) {
    case "darwin":
      return path.join("Electron.app", "Contents", "MacOS", "Electron");
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

const electronExecutablePath = path.join(electronPackageDirectory, "dist", platformPath);

const runElectronInstall = (force) => {
  const result = spawnSync(process.execPath, [installScriptPath], {
    stdio: "inherit",
    env: {
      ...process.env,
      ELECTRON_SKIP_BINARY_DOWNLOAD: "",
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

runElectronInstall(false);

if (!existsSync(electronExecutablePath)) {
  rmSync(path.join(electronPackageDirectory, "dist"), { force: true, recursive: true });
  rmSync(path.join(electronPackageDirectory, "path.txt"), { force: true });
  runElectronInstall(true);
}

if (!existsSync(electronExecutablePath)) {
  console.error(`Electron executable was not installed at ${electronExecutablePath}`);
  process.exit(1);
}

console.log(`Electron executable available at ${electronExecutablePath}`);
