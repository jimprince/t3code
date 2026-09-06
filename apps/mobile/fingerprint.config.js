// @ts-check
const fs = require("node:fs");
const path = require("node:path");

const PNPM_STORE_NODE_MODULES_PATTERN = /((?:\.\.\/)+node_modules)\/\.pnpm\/[^/]+\/node_modules\//g;

// Expo's fingerprint ignores the app version, so binaries of different majors
// share a runtime version whenever native code is unchanged, and a production
// OTA from main would reach every older store binary. Hashing the major
// version keeps each major's OTAs on its own binaries: a new major reaches
// users only once its store build is promoted.
const appConfig = fs.readFileSync(path.join(__dirname, "app.config.ts"), "utf8");
const majorVersion = appConfig.match(/^ {2}version: "(\d+)\./m)?.[1];
if (!majorVersion) {
  throw new Error("fingerprint.config.js could not read the app version from app.config.ts");
}

module.exports = {
  // Hash the pinned Screens fork's native source, rather than only its version.
  nativeModuleSourceType: "files",
  /**
   * @param {{ type: "file", filePath: string } | { type: "contents", id: string }} source
   * @param {Buffer | string | null} chunk
   * @param {boolean} isEndOfFile
   */
  fileHookTransform(source, chunk, isEndOfFile) {
    if (!isEndOfFile || source.type !== "contents" || typeof chunk !== "string") {
      return chunk;
    }

    if (!source.id.includes("AutolinkingConfig")) {
      return chunk;
    }

    return chunk.replace(PNPM_STORE_NODE_MODULES_PATTERN, "$1/");
  },
  extraSources: [{ type: "contents", id: "appMajorVersion", contents: majorVersion }],
};
