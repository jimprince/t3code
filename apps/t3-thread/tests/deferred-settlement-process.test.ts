import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeUtil from "node:util";
import { expect, it } from "vite-plus/test";

const execFile = NodeUtil.promisify(NodeChildProcess.execFile);
const workspace = NodeURL.fileURLToPath(new URL("..", import.meta.url));

it.each([false, true])(
  "the helper outlives its CLI and honors the final response or cancellation (%s)",
  async (cancel) => {
    const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-deferred-process-"));
    let childPid: number | undefined;
    try {
      const entry = NodePath.join(directory, "fixture.mts");
      const finalPath = NodePath.join(directory, "final.json");
      await NodeFSP.writeFile(
        entry,
        `
      import { readFile } from 'node:fs/promises';
      import { watch } from 'node:fs';
      import { startDeferredSettlement, runDeferredSettlement, cancelDeferredSettlement } from ${JSON.stringify(NodePath.join(workspace, "src/deferredSettlement.ts"))};
      const request = { threadId: 'self', environment: 'test', turnId: 'turn', unsettledAt: null };
      if (process.argv[2] === 'cancel') {
        await cancelDeferredSettlement('test', 'self');
      } else if (process.argv[2] === 'settle-after-turn') {
        await runDeferredSettlement(JSON.parse(process.argv[3]), {
          findThread: async () => new Promise((resolve, reject) => {
            const watcher = watch(${JSON.stringify(directory)}, () => check());
            async function check() {
              try {
                const thread = JSON.parse(await readFile(${JSON.stringify(finalPath)}, 'utf8'));
                watcher.close(); resolve(thread);
              } catch (error) { if (error.code !== 'ENOENT') { watcher.close(); reject(error); } }
            }
            check();
          }),
          settleThread: async () => ({ settledOverride: 'settled', settledAt: '2026-09-09T12:00:00Z' }),
        });
      } else {
        console.log(JSON.stringify(await startDeferredSettlement(request)));
      }
    `,
      );
      // Resolves only after the requesting process exits; the helper must survive it.
      const parent = await execFile(NodePath.join(workspace, "node_modules/.bin/tsx"), [entry], {
        env: { ...process.env, T3_AGENT_STATE_FILE: NodePath.join(directory, "state.json") },
      });
      const accepted = JSON.parse(parent.stdout) as {
        deferred: boolean;
        pid: number;
        logPath: string;
      };
      childPid = accepted.pid;
      expect(accepted.deferred).toBe(true);
      expect(await NodeFSP.readFile(accepted.logPath, "utf8")).toBe("");
      expect((await NodeFSP.stat(accepted.logPath)).mode & 0o777).toBe(0o600);
      const result = new Promise<string>((resolve, reject) => {
        const watcher = NodeFS.watch(accepted.logPath, async () => {
          try {
            const text = await NodeFSP.readFile(accepted.logPath, "utf8");
            if (text.endsWith("\n")) {
              watcher.close();
              resolve(text);
            }
          } catch (error) {
            watcher.close();
            reject(error);
          }
        });
      });
      if (cancel) {
        await execFile(NodePath.join(workspace, "node_modules/.bin/tsx"), [entry, "cancel"], {
          env: { ...process.env, T3_AGENT_STATE_FILE: NodePath.join(directory, "state.json") },
        });
      }
      const thread = {
        id: "self",
        archivedAt: null,
        proposedPlans: [],
        session: null,
        latestTurn: {
          turnId: "turn",
          state: "completed",
          completedAt: "2026-09-09T12:00:00Z",
          assistantMessageId: "final",
        },
        messages: [
          { id: "final", role: "assistant", turnId: "turn", streaming: false, text: "Done" },
        ],
      };
      const temporary = `${finalPath}.tmp`;
      await NodeFSP.writeFile(temporary, JSON.stringify(thread));
      await NodeFSP.rename(temporary, finalPath);
      expect(JSON.parse(await result)).toMatchObject(
        cancel ? { cancelled: true } : { settled: true, result: { settledOverride: "settled" } },
      );
    } finally {
      if (childPid) {
        try {
          process.kill(childPid);
        } catch {}
      }
      await NodeFSP.rm(directory, { recursive: true, force: true });
    }
  },
  15_000,
);
