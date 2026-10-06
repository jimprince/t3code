import * as NodeFS from "node:fs";
import * as NodeURL from "node:url";
import { sourceHash } from "./runtime-build.mjs";

const workspace = NodeURL.fileURLToPath(new URL("..", import.meta.url));
try {
  const stamp = JSON.parse(NodeFS.readFileSync(`${workspace}/dist/build-stamp.json`, "utf8"));
  if (stamp.sourceHash !== sourceHash(workspace)) throw new Error("build is stale");
  NodeFS.accessSync(`${workspace}/dist/cli.cjs`);
} catch (error) {
  console.error(
    `t3-thread: ${error.message}. Run 'node scripts/build.mjs' in ${workspace}, or explicitly use T3_THREAD_DEV=1 for tsx. No automatic rebuild was attempted.`,
  );
  process.exitCode = 1;
}

if (!process.exitCode) await import(`${workspace}/dist/cli.cjs`);
