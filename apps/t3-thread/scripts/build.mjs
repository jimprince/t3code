import { build } from "esbuild";
import * as NodeFS from "node:fs";
import * as NodeURL from "node:url";
import { sourceHash } from "./runtime-build.mjs";

const workspace = NodeURL.fileURLToPath(new URL("..", import.meta.url));
const hash = sourceHash(workspace);
await build({
  absWorkingDir: workspace,
  entryPoints: ["src/cli.ts"],
  bundle: true,
  platform: "node",
  format: "cjs",
  outfile: "dist/cli.cjs",
});
if (sourceHash(workspace) !== hash)
  throw new Error("Sources changed during build; run build again.");
NodeFS.mkdirSync(`${workspace}/dist`, { recursive: true });
NodeFS.writeFileSync(
  `${workspace}/dist/build-stamp.json`,
  JSON.stringify({ sourceHash: hash }) + "\n",
);
