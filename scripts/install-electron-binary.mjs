import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(new URL("../apps/desktop/package.json", import.meta.url));
const electronPackageJsonPath = require.resolve("electron/package.json");
const electronPackageDirectory = path.dirname(electronPackageJsonPath);
const electronRequire = createRequire(electronPackageJsonPath);
const installScriptPath = path.join(electronPackageDirectory, "install.js");
const { downloadArtifact } = electronRequire("@electron/get");
const extract = electronRequire("extract-zip");
const checksums = electronRequire("./checksums.json");
const { version } = electronRequire("./package.json");

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
const distPath = path.join(electronPackageDirectory, "dist");

const runElectronInstall = (force) => {
  const result = spawnSync(process.execPath, [installScriptPath], {
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

const downloadAndExtractElectron = async () => {
  rmSync(distPath, { force: true, recursive: true });
  rmSync(path.join(electronPackageDirectory, "path.txt"), { force: true });

  const zipPath = await downloadArtifact({
    version,
    artifactName: "electron",
    force: true,
    checksums,
    platform: process.platform,
    arch: process.arch,
  });

  await extract(zipPath, { dir: distPath });

  const extractedTypesPath = path.join(distPath, "electron.d.ts");
  if (existsSync(extractedTypesPath)) {
    renameSync(extractedTypesPath, path.join(electronPackageDirectory, "electron.d.ts"));
  }

  writeFileSync(path.join(electronPackageDirectory, "path.txt"), platformPath);
};

runElectronInstall(false);

if (!existsSync(electronExecutablePath)) {
  await downloadAndExtractElectron();
}

if (!existsSync(electronExecutablePath)) {
  const distEntries = existsSync(distPath) ? readdirSync(distPath).join(", ") : "<missing>";
  console.error(
    `Electron install did not create ${platformPath} for ${process.platform}/${process.arch}. dist contains: ${distEntries}`,
  );
  console.error(`Electron executable was not installed at ${electronExecutablePath}`);
  process.exit(1);
}

console.log(`Electron executable available at ${electronExecutablePath}`);
