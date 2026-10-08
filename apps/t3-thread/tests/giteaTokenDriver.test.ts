import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { expect, it } from "vite-plus/test";
const driver = NodeURL.fileURLToPath(
  new URL("./fixtures/gitea-token-producer-driver.py", import.meta.url),
);
const consumer = NodeURL.fileURLToPath(
  new URL("./fixtures/gitea-token-consumer.ts", import.meta.url),
);
const tsx = NodeURL.fileURLToPath(new URL("../node_modules/.bin/tsx", import.meta.url));
const sentinel = "synthetic-producer-test-only";

it("starts the consumer before a single bounded write, closes EOF and prints only its receipt", async () => {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-gitea-driver-"));
  const producer = NodePath.join(directory, "producer.py");
  const code = `import os\ndef supply_id3(fd):\n assert consumer_started\n os.write(fd, b'${sentinel}\\n')\n`;
  await NodeFSP.writeFile(producer, code, { mode: 0o600 });
  try {
    const run = NodeChildProcess.spawnSync(
      "python3",
      [driver, producer, NodeCrypto.createHash("sha256").update(code).digest("hex"), tsx, consumer],
      { encoding: "utf8", timeout: 10_000 },
    );
    expect(run.status, run.stdout + run.stderr).toBe(0);
    expect(JSON.parse(run.stdout)).toEqual({
      instanceId: "fake",
      tokenSet: true,
      storedMatchesInput: true,
    });
    expect(run.stdout + run.stderr).not.toContain(sentinel);
    const rejected = NodeChildProcess.spawnSync(
      "python3",
      [driver, producer, "0".repeat(64), tsx, consumer],
      {
        encoding: "utf8",
        timeout: 10_000,
      },
    );
    expect(rejected.status).toBe(2);
    expect(rejected.stdout + rejected.stderr).not.toContain(sentinel);
    // Replace the producer's pathname after hashing: only the verified bytes execute.
    const race = NodeChildProcess.spawnSync(
      "python3",
      [
        "-B",
        "-c",
        `import importlib.util,sys\ns=importlib.util.spec_from_file_location('driver',sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)\ncode,message=m.drive(sys.argv[2],sys.argv[3],sys.argv[4:],after_hash=lambda:open(sys.argv[2],'w').write('raise Exception(\\"${sentinel}\\")'))\nprint(message);sys.exit(code)`,
        driver,
        producer,
        NodeCrypto.createHash("sha256").update(code).digest("hex"),
        tsx,
        consumer,
      ],
      { encoding: "utf8", timeout: 10_000 },
    );
    expect(race.status, race.stderr).toBe(0);
    expect(race.stdout + race.stderr).not.toContain(sentinel);
  } finally {
    await NodeFSP.rm(directory, { recursive: true, force: true });
  }
}, 30_000);

it("bounds reaping after EOF and reports an uncertain outcome without retry or input leakage", async () => {
  const directory = await NodeFSP.mkdtemp(
    NodePath.join(NodeOS.tmpdir(), "t3-gitea-driver-timeout-"),
  );
  const producer = NodePath.join(directory, "producer.py");
  const code = `import os\ndef supply_id3(fd):\n os.write(fd, b'${sentinel}\\n')\n`;
  await NodeFSP.writeFile(producer, code, { mode: 0o600 });
  try {
    const run = NodeChildProcess.spawnSync(
      "python3",
      [
        "-B",
        "-c",
        "import importlib.util,sys; s=importlib.util.spec_from_file_location('driver',sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m);code,message=m.drive(sys.argv[2],sys.argv[3],sys.argv[4:],reap_seconds=0.1);print(message);sys.exit(code)",
        driver,
        producer,
        NodeCrypto.createHash("sha256").update(code).digest("hex"),
        process.execPath,
        "-e",
        "process.stdin.resume();setTimeout(()=>{},10000)",
      ],
      { encoding: "utf8", timeout: 10_000 },
    );
    expect(run.status).toBe(30);
    expect(run.stdout).toContain("uncertain");
    expect(run.stdout + run.stderr).not.toContain(sentinel);
  } finally {
    await NodeFSP.rm(directory, { recursive: true, force: true });
  }
}, 15_000);
