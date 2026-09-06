#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalTimers:off
// @effect-diagnostics globalDate:off
// @effect-diagnostics globalConsole:off
// @effect-diagnostics globalFetch:off

import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import * as NodeURL from "node:url";
import * as NodeTimersPromises from "node:timers/promises";

const fixtures = new URL("./fixtures/thread-history/", import.meta.url);
const now = "2026-09-01T00:00:00.000Z";

type HistoricalEvent = { type: string; payload: Record<string, unknown> };

async function seed(databasePath: string, workspace: string, version: string) {
  const database = new NodeSqlite.DatabaseSync(databasePath);
  try {
    database.exec(await NodeFSP.readFile(new URL("1293-fork.2.sql", fixtures), "utf8"));
    if (version === "1400-fork.1") {
      database.exec(await NodeFSP.readFile(new URL("1400-fork.1.sql", fixtures), "utf8"));
    }
    const events = JSON.parse(
      await NodeFSP.readFile(new URL("events.json", fixtures), "utf8"),
    ) as HistoricalEvent[];
    const insert = database.prepare(`INSERT INTO orchestration_events
      (sequence, event_id, aggregate_kind, stream_id, stream_version, event_type,
       occurred_at, command_id, causation_event_id, correlation_id, actor_kind, payload_json, metadata_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const versions = new Map<string, number>();
    for (const [index, event] of events.entries()) {
      if (event.type === "project.created") event.payload.workspaceRoot = workspace;
      const kind = event.type.startsWith("project.") ? "project" : "thread";
      const id = String(event.payload[kind === "project" ? "projectId" : "threadId"]);
      const version = (versions.get(id) ?? 0) + 1;
      versions.set(id, version);
      insert.run(
        100 + index,
        `history-${index}`,
        kind,
        id,
        version,
        event.type,
        now,
        `command-${index}`,
        null,
        "upgrade-fixture",
        "client",
        JSON.stringify(event.payload),
        '{"origin":{"surface":"cli"}}',
      );
    }
    return {
      events: database.prepare("SELECT * FROM orchestration_events ORDER BY sequence").all(),
      ledger: database
        .prepare("SELECT * FROM effect_sql_fork_migrations ORDER BY migration_id")
        .all(),
    };
  } finally {
    database.close();
  }
}

function verify(databasePath: string, before: Awaited<ReturnType<typeof seed>>) {
  const database = new NodeSqlite.DatabaseSync(databasePath, { readOnly: true });
  try {
    const events = database
      .prepare(
        "SELECT * FROM orchestration_events WHERE event_id LIKE 'history-%' ORDER BY sequence",
      )
      .all();
    NodeAssert.equal(events.length, before.events.length, "Historical event loss");
    for (const [index, original] of before.events.entries()) {
      const expected = { ...original };
      if (original.event_type === "thread.sidebar-reordered") {
        const { orderKey, ...payload } = JSON.parse(String(original.payload_json));
        expected.event_type = "thread.meta-updated";
        expected.payload_json = JSON.stringify({ ...payload, activeOrderKey: orderKey });
      }
      const actual = events[index]!;
      NodeAssert.deepEqual(
        { ...actual, payload_json: JSON.parse(String(actual.payload_json)) },
        { ...expected, payload_json: JSON.parse(String(expected.payload_json)) },
        "Historical event changed unexpectedly",
      );
    }
    NodeAssert.deepEqual(
      database
        .prepare(
          "SELECT * FROM effect_sql_fork_migrations WHERE migration_id <= 4 ORDER BY migration_id",
        )
        .all(),
      before.ledger,
      "Previously shipped migration identities must remain intact",
    );
    NodeAssert.deepEqual(
      database.prepare("SELECT name FROM effect_sql_fork_migrations WHERE migration_id = 5").get(),
      Object.assign(Object.create(null), { name: "MigrateSidebarOrderEvents" }),
    );
    const ordered = database
      .prepare(
        "SELECT title, active_order_key, goal_json FROM projection_threads WHERE thread_id = 'upgrade-ordered'",
      )
      .get();
    NodeAssert.equal(ordered?.title, "Historical ordered");
    NodeAssert.equal(ordered?.active_order_key, "a0", "Historical ordering did not replay");
    const goal = JSON.parse(String(ordered?.goal_json));
    NodeAssert.equal(goal.goal, "Preserve historical goal");
    NodeAssert.equal(goal.status, "achieved");
    const cleared = database
      .prepare(
        "SELECT active_order_key, goal_json FROM projection_threads WHERE thread_id = 'upgrade-cleared'",
      )
      .get();
    NodeAssert.equal(cleared?.active_order_key, null, "Null ordering did not replay");
    NodeAssert.equal(cleared?.goal_json, null, "Cleared historical goal came back");
    NodeAssert.equal(
      database
        .prepare(
          "SELECT count(*) AS count FROM projection_thread_messages WHERE message_id IN ('message-ordered', 'message-cleared') AND text = 'Historical conversation survives the upgrade.'",
        )
        .get()?.count,
      2,
    );
    const messages = database
      .prepare(
        "SELECT file_attachments_json FROM projection_thread_messages WHERE message_id IN ('message-ordered', 'message-cleared')",
      )
      .all();
    for (const message of messages) {
      NodeAssert.deepEqual(JSON.parse(String(message.file_attachments_json)), [
        {
          type: "file",
          id: "legacy-file",
          name: "notes.txt",
          mimeType: "text/plain",
          sizeBytes: 12,
          path: "/tmp/historical-notes.txt",
        },
      ]);
    }
    NodeAssert.equal(
      database.prepare("SELECT count(*) AS count FROM projection_turns").get()?.count,
      0,
      "Upgrade started unexpected turns",
    );
    NodeAssert.equal(database.prepare("PRAGMA integrity_check").get()?.integrity_check, "ok");
  } finally {
    database.close();
  }
}

async function availablePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = NodeNet.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      NodeAssert.ok(address && typeof address === "object");
      server.close(() => resolve(address.port));
    });
  });
}

async function boot(command: readonly string[], cwd: string, home: string, workspace: string) {
  const port = await availablePort();
  const child = NodeChildProcess.spawn(
    command[0]!,
    [
      ...command.slice(1),
      "serve",
      "--mode",
      "web",
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
      "--no-browser",
      "--base-dir",
      home,
      workspace,
    ],
    {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: "1",
        HOME: home,
        XDG_CONFIG_HOME: NodePath.join(home, "config"),
        T3CODE_HOME: home,
        T3CODE_LOG_LEVEL: "Error",
      },
    },
  );
  let output = "";
  for (const stream of [child.stdout, child.stderr]) {
    stream.on("data", (data: Buffer) => {
      output = (output + data.toString()).slice(-20_000);
    });
  }
  const closed = new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  // Child completion is observed immediately, including spawn errors.
  let failure: Error | undefined;
  void closed.then(
    (code) => {
      failure = new Error(`Historical startup exited (${code}).\n${output}`);
    },
    (error: Error) => {
      failure = error;
    },
  );
  try {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      if (failure) throw failure;
      try {
        const response = await fetch(`http://127.0.0.1:${port}/`, {
          signal: AbortSignal.timeout(1_000),
        });
        await response.arrayBuffer();
        if (response.status === 200) return;
      } catch {
        /* The packaged process has not bound its HTTP listener yet. */
      }
      await NodeTimersPromises.setTimeout(100);
    }
    throw new Error(`Historical startup did not become ready.\n${output}`);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    await Promise.race([
      closed.catch(() => {}),
      NodeTimersPromises.setTimeout(5_000, undefined, { ref: false }),
    ]);
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await closed.catch(() => {});
  }
}

/** Exercise released schemas and records with the packaged server, without user data or credentials. */
export async function smokeThreadHistory(command: readonly string[], cwd: string) {
  for (const version of ["1293-fork.2", "1400-fork.1"]) {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-history-upgrade-"));
    try {
      const home = NodePath.join(root, "home");
      const workspace = NodePath.join(root, "workspace");
      await NodeFSP.mkdir(NodePath.join(home, "userdata"), { recursive: true });
      await NodeFSP.mkdir(workspace);
      const databasePath = NodePath.join(home, "userdata/state.sqlite");
      const before = await seed(databasePath, workspace, version);
      await boot(command, cwd, home, workspace);
      verify(databasePath, before);
      // Restart the same database to verify idempotency and rebuilt projections.
      await boot(command, cwd, home, workspace);
      verify(databasePath, before);
      console.log(
        `Historical startup passed: ${version} (migration, replay, preservation, restart).`,
      );
    } finally {
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  }
}

if (
  process.argv[1] &&
  import.meta.url === NodeURL.pathToFileURL(NodePath.resolve(process.argv[1])).href
) {
  const command = process.argv.slice(2);
  NodeAssert.ok(
    command.length > 0,
    "Usage: node scripts/smoke-thread-history.ts <runtime> <packaged-bin.mjs>",
  );
  await smokeThreadHistory(command, NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)));
}
