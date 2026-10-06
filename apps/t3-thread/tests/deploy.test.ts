import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeURL from "node:url";
import * as NodeUtil from "node:util";
import { expect, it } from "vite-plus/test";

// The fixture verifies real Linux procfs identities and captured child processes; its 21 Python
// cases take about 20 s on the dev VM, so the default 15 s budget is too tight.
it.skipIf(!NodeFS.existsSync("/proc/sys/kernel/random/boot_id"))(
  "deploys the verified runtime and preserves leased watchers before pruning",
  async () => {
    const run = NodeUtil.promisify(NodeChildProcess.execFile);
    const result = await run("python3", [
      NodeURL.fileURLToPath(new URL("./deploy_test.py", import.meta.url)),
    ]);
    expect(result.stderr).toContain("OK");
  },
  60_000,
);
