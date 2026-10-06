// @effect-diagnostics nodeBuiltinImport:off -- Privileged offline operator boundary.
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as NodeFSP from "node:fs/promises";
import * as NodeChildProcess from "node:child_process";

const disappeared = (error: unknown) =>
  error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "ESRCH");

/** Refuse a listening server or any holder of the DB, WAL or SHM. Permission gaps fail closed. */
export async function verifyRepairOffline(
  databasePath: string,
  port: number,
  procRoot = "/proc",
): Promise<void> {
  const platform = HostProcess.Platform.defaultValue();
  const paths = [databasePath, `${databasePath}-wal`, `${databasePath}-shm`];
  if (platform === "darwin") {
    const check = (args: string[]) => {
      const result = NodeChildProcess.spawnSync("/usr/sbin/lsof", args, { encoding: "utf8" });
      if (result.error || (result.status !== 0 && result.status !== 1) || result.stderr.trim())
        throw new Error(
          "Cannot verify offline ownership with lsof; run with sufficient privileges.",
        );
      if (result.stdout.trim())
        throw new Error(
          `Offline repair refused: process(es) ${result.stdout.trim()} still own the server port or database.`,
        );
    };
    check(["-t", `-iTCP:${port}`, "-sTCP:LISTEN"]);
    const existing: string[] = [];
    for (const path of paths) {
      try {
        await NodeFSP.stat(path);
        existing.push(path);
      } catch (error) {
        if (!disappeared(error)) throw error;
      }
    }
    check(["-t", "--", ...existing]);
    return;
  }
  if (platform !== "linux") throw new Error("Offline apply requires Linux or macOS.");
  for (const table of [`${procRoot}/net/tcp`, `${procRoot}/net/tcp6`]) {
    const sockets = await NodeFSP.readFile(table, "utf8");
    if (
      sockets
        .split("\n")
        .slice(1)
        .some((line) => {
          const fields = line.trim().split(/\s+/);
          return fields[3] === "0A" && Number.parseInt(fields[1]?.split(":")[1] ?? "", 16) === port;
        })
    )
      throw new Error(`Offline repair refused: a listener is still on configured port ${port}.`);
  }
  const targets = [];
  for (const path of paths) {
    try {
      targets.push(await NodeFSP.stat(path));
    } catch (error) {
      if (!disappeared(error)) throw error;
    }
  }
  for (const pid of await NodeFSP.readdir(procRoot)) {
    if (!/^\d+$/.test(pid) || pid === String(process.pid)) continue;
    let fds: string[];
    try {
      fds = await NodeFSP.readdir(`${procRoot}/${pid}/fd`);
    } catch (error) {
      if (disappeared(error)) continue;
      throw new Error(
        `Cannot inspect process ${pid}; run offline repair with sufficient privileges.`,
        { cause: error },
      );
    }
    for (const fd of fds) {
      try {
        const stat = await NodeFSP.stat(`${procRoot}/${pid}/fd/${fd}`);
        if (targets.some((target) => stat.dev === target.dev && stat.ino === target.ino))
          throw new Error(`Offline repair refused: database/WAL/SHM is open in process ${pid}.`);
      } catch (error) {
        if (!disappeared(error)) throw error;
      }
    }
  }
}
