import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, it } from "vite-plus/test";

it("deploys the verified runtime and recovers only its managed watcher before pruning", async () => {
  const run = promisify(execFile);
  const result = await run("python3", [
    fileURLToPath(new URL("./deploy_test.py", import.meta.url)),
  ]);
  expect(result.stderr).toContain("OK");
}, 15_000);
