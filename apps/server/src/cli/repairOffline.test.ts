// @effect-diagnostics nodeBuiltinImport:off -- Offline ownership uses real filesystem identities.
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeNet from "node:net";
import { afterEach, expect, it } from "vite-plus/test";
import { verifyRepairOffline } from "./repairOffline.ts";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await NodeFSP.rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "repair-offline-"));
  roots.push(root);
  const proc = NodePath.join(root, "proc");
  const database = NodePath.join(root, "statev2.sqlite");
  await NodeFSP.mkdir(`${proc}/net`, { recursive: true });
  await NodeFSP.writeFile(database, "fixture");
  for (const table of ["tcp", "tcp6"]) await NodeFSP.writeFile(`${proc}/net/${table}`, "header\n");
  return { proc, database };
}
it.skipIf(HostProcessPlatform.defaultValue() !== "linux")(
  "permits an offline DB and refuses each main/WAL/SHM holder",
  async () => {
    const { proc, database } = await fixture();
    await expect(verifyRepairOffline(database, 12345, proc)).resolves.toBeUndefined();
    await NodeFSP.mkdir(`${proc}/123/fd`, { recursive: true });
    for (const suffix of ["", "-wal", "-shm"]) {
      if (suffix) await NodeFSP.writeFile(`${database}${suffix}`, "journal");
      await NodeFSP.symlink(`${database}${suffix}`, `${proc}/123/fd/3`);
      await expect(verifyRepairOffline(database, 12345, proc)).rejects.toThrow(
        "database/WAL/SHM is open in process 123",
      );
      await NodeFSP.unlink(`${proc}/123/fd/3`);
    }
    await expect(verifyRepairOffline(database, 12345, proc)).resolves.toBeUndefined();
  },
);
it.skipIf(HostProcessPlatform.defaultValue() !== "linux")(
  "refuses a real listener before opening the database",
  async () => {
    const server = NodeNet.createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No TCP port");
    try {
      await expect(verifyRepairOffline("/nonexistent/database", address.port)).rejects.toThrow(
        "listener is still on configured port",
      );
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  },
);
it.skipIf(HostProcessPlatform.defaultValue() !== "linux")(
  "fails closed when ownership inspection cannot be completed",
  async () => {
    const { proc, database } = await fixture();
    await NodeFSP.mkdir(`${proc}/123`, { recursive: true });
    await NodeFSP.writeFile(`${proc}/123/fd`, "not an inspectable directory");
    await expect(verifyRepairOffline(database, 12345, proc)).rejects.toThrow(
      "Cannot inspect process 123",
    );
  },
);
