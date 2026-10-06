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
    database.exec(
      await NodeFSP.readFile(
        new URL(version === "m4-cut" ? "m4-cut.sql" : "1293-fork.2.sql", fixtures),
        "utf8",
      ),
    );
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
    await NodeFSP.writeFile(NodePath.join(workspace, "historical-notes.txt"), "hello world!");
    for (const [index, event] of events.entries()) {
      if (version === "m4-cut" && event.type === "thread.sidebar-reordered") {
        const { orderKey, ...payload } = event.payload;
        event.type = "thread.meta-updated";
        event.payload = { ...payload, activeOrderKey: orderKey };
      }
      if (event.type === "project.created") event.payload.workspaceRoot = workspace;
      const kind = event.type.startsWith("project.") ? "project" : "thread";
      const id = String(event.payload[kind === "project" ? "projectId" : "threadId"]);
      const streamVersion = (versions.get(id) ?? 0) + 1;
      versions.set(id, streamVersion);
      insert.run(
        100 + index,
        `history-${index}`,
        kind,
        id,
        streamVersion,
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
    // V2 imports the persisted V1 projections rather than replaying V1 events.
    const put = (table: string, fields: Record<string, unknown>) => {
      const columns = database
        .prepare(`PRAGMA table_info(${table})`)
        .all()
        .map((row) => row.name);
      const entries = Object.entries(fields).filter(([key]) => columns.includes(key));
      database
        .prepare(
          `INSERT INTO ${table} (${entries.map(([key]) => key).join(",")}) VALUES (${entries.map(() => "?").join(",")})`,
        )
        .run(...entries.map(([, value]) => value as string | number | null));
    };
    put("projection_projects", {
      project_id: "upgrade-project",
      title: "Historical workspace",
      workspace_root: workspace,
      scripts_json: "[]",
      created_at: now,
      updated_at: now,
    });
    for (const suffix of ["ordered", "cleared"]) {
      put("projection_threads", {
        thread_id: `upgrade-${suffix}`,
        project_id: "upgrade-project",
        title: `Historical ${suffix}`,
        model_selection_json: '{"instanceId":"codex","model":"gpt-5-codex"}',
        runtime_mode: "full-access",
        interaction_mode: "default",
        created_at: now,
        updated_at: now,
        sidebar_order_key: suffix === "ordered" ? "a0" : null,
        active_order_key: suffix === "ordered" ? "a0" : null,
        goal_json:
          suffix === "ordered"
            ? JSON.stringify({ goal: "Preserve historical goal", status: "achieved" })
            : null,
      });
      put("projection_thread_messages", {
        message_id: `message-${suffix}`,
        thread_id: `upgrade-${suffix}`,
        role: "assistant",
        text: "Historical conversation survives the upgrade.",
        is_streaming: 0,
        created_at: now,
        updated_at: now,
        file_attachments_json: JSON.stringify([
          {
            type: "file",
            id: "legacy-file",
            name: "notes.txt",
            mimeType: "text/plain",
            sizeBytes: 12,
            path: NodePath.join(
              workspace,
              suffix === "ordered" ? "historical-notes.txt" : "missing-notes.txt",
            ),
          },
        ]),
      });
    }
    return {
      version,
      legacyMessages: database
        .prepare("SELECT * FROM projection_thread_messages ORDER BY message_id")
        .all(),
      mainLedger: database
        .prepare("SELECT * FROM effect_sql_migrations ORDER BY migration_id")
        .all(),
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
          "SELECT * FROM effect_sql_fork_migrations WHERE migration_id IN (" +
            before.ledger.map((row) => row.migration_id).join(",") +
            ") ORDER BY migration_id",
        )
        .all(),
      before.ledger,
      "Previously shipped migration identities must remain intact",
    );
    NodeAssert.deepEqual(
      database.prepare("SELECT name FROM effect_sql_fork_migrations WHERE migration_id = 5").get(),
      Object.assign(Object.create(null), { name: "MigrateSidebarOrderEvents" }),
    );
    NodeAssert.deepEqual(
      database
        .prepare(
          "SELECT * FROM effect_sql_migrations WHERE migration_id <= ? ORDER BY migration_id",
        )
        .all(Number(before.mainLedger.at(-1)?.migration_id)),
      before.mainLedger,
      "Previously shipped main migrations must not rerun",
    );
    NodeAssert.deepEqual(
      database
        .prepare(
          "SELECT migration_id FROM effect_sql_migrations WHERE migration_id > 60 ORDER BY migration_id",
        )
        .all()
        .map((row) => row.migration_id),
      [61, 62],
      "V2 migrations must not be skipped under main ledger 60",
    );
    NodeAssert.deepEqual(
      database
        .prepare(
          "SELECT migration_id FROM effect_sql_fork_migrations WHERE migration_id != 4 ORDER BY migration_id",
        )
        .all()
        .map((row) => row.migration_id),
      [1, 2, 3, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
    );
    const v2Ordered = database
      .prepare(
        "SELECT payload_json FROM orchestration_v2_projection_threads WHERE thread_id = 'upgrade-ordered'",
      )
      .get();
    NodeAssert.ok(v2Ordered, "Historical thread was not imported to V2");
    NodeAssert.equal(JSON.parse(String(v2Ordered.payload_json)).activeOrderKey, "a0");
    NodeAssert.equal(
      database
        .prepare(
          "SELECT count(*) AS count FROM orchestration_v2_projection_messages WHERE message_id IN ('message-ordered', 'message-cleared')",
        )
        .get()?.count,
      2,
      "Packaged RPC did not import the historical transcript",
    );
    const ordered = database
      .prepare(
        "SELECT title, active_order_key, goal_json FROM projection_threads WHERE thread_id = 'upgrade-ordered'",
      )
      .get();
    NodeAssert.equal(ordered?.title, "Historical ordered");
    NodeAssert.equal(
      ordered?.active_order_key,
      before.version === "1293-fork.2" ? null : "a0",
      "Legacy ordering projection was modified",
    );
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
    for (const suffix of ["ordered", "cleared"]) {
      const row = database
        .prepare(
          "SELECT payload_json FROM orchestration_v2_projection_messages WHERE message_id = ?",
        )
        .get(`message-${suffix}`);
      const message = JSON.parse(String(row?.payload_json)) as {
        attachments: Array<{ type: string; name: string; sizeBytes: number }>;
      };
      NodeAssert.equal(message.attachments.length, 1, "Historical file handoff disappeared");
      NodeAssert.equal(
        message.attachments[0]?.type,
        suffix === "ordered" ? "file" : "legacy-missing",
      );
      NodeAssert.equal(message.attachments[0]?.sizeBytes, 12);
    }
    // TODO(fork-thread-history-compatibility): after the threads lane is integrated,
    // assert the historical achieved/cleared goals through its read-only history RPC.
    NodeAssert.deepEqual(
      database.prepare("SELECT * FROM projection_thread_messages ORDER BY message_id").all(),
      before.legacyMessages,
      "Legacy messages/file handoffs were modified by V2 import",
    );
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

/** Read through the packaged V2 RPC so lazy transcript imports are part of the gate. */
async function importPackagedHistory(
  command: readonly string[],
  cwd: string,
  home: string,
  port: number,
) {
  const output = await new Promise<string>((resolve, reject) => {
    NodeChildProcess.execFile(
      command[0]!,
      [...command.slice(1), "pair", "--home-dir", home],
      {
        cwd,
        env: { ...process.env, HOME: home, T3CODE_HOME: home, ELECTRON_RUN_AS_NODE: "1" },
      },
      (error, stdout) =>
        error ? reject(new Error("Packaged pairing failed", { cause: error })) : resolve(stdout),
    );
  });
  const credential = /pair#token=([A-Z2-9]+)/.exec(output)?.[1];
  NodeAssert.ok(credential, "Packaged CLI did not issue an isolated pairing credential");
  const origin = `http://127.0.0.1:${port}`;
  const exchanged = await fetch(`${origin}/oauth/token`, {
    method: "POST",
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
      subject_token: credential,
      subject_token_type: "urn:t3:params:oauth:token-type:environment-bootstrap",
      requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
    }),
  });
  NodeAssert.equal(exchanged.status, 200, "Packaged token exchange failed");
  const session = (await exchanged.json()) as { access_token: string };
  const ticketResponse = await fetch(`${origin}/api/auth/websocket-ticket`, {
    method: "POST",
    headers: { authorization: `Bearer ${session.access_token}` },
  });
  NodeAssert.equal(ticketResponse.status, 200, "Packaged WebSocket ticket failed");
  const ticket = (await ticketResponse.json()) as { ticket: string };
  const socket = new WebSocket(
    `ws://127.0.0.1:${port}/ws?wsTicket=${encodeURIComponent(ticket.ticket)}&orchestrationProtocol=2`,
  );
  const pending = new Map<string, { resolve: () => void; reject: (error: Error) => void }>();
  socket.addEventListener("message", (event) => {
    const decoded: unknown = JSON.parse(String(event.data));
    for (const message of (Array.isArray(decoded) ? decoded : [decoded]) as Array<{
      _tag: string;
      requestId: string;
      exit?: { _tag: string };
    }>) {
      if (message._tag !== "Exit") continue;
      const receipt = pending.get(String(message.requestId));
      if (message.exit?._tag === "Success") receipt?.resolve();
      else receipt?.reject(new Error("Packaged history projection RPC failed"));
    }
  });
  socket.addEventListener("close", () => {
    for (const receipt of pending.values())
      receipt.reject(new Error("Packaged history socket closed before its receipt"));
  });
  try {
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => resolve(), { once: true });
      socket.addEventListener("error", () => reject(new Error("Packaged history socket failed")), {
        once: true,
      });
    });
    for (const [index, threadId] of ["upgrade-ordered", "upgrade-cleared"].entries()) {
      const id = String(index + 1);
      await new Promise<void>((resolve, reject) => {
        pending.set(id, { resolve, reject });
        socket.send(
          JSON.stringify({
            _tag: "Request",
            id,
            tag: "orchestration.getThreadProjection",
            payload: { threadId },
            headers: [],
          }),
        );
      });
      pending.delete(id);
    }
  } finally {
    socket.close();
  }
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
      "--home-dir",
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
        T3CODE_DISABLE_STARTUP_RESUME: "1",
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
        if (response.status === 200) break;
      } catch {
        /* The packaged process has not bound its HTTP listener yet. */
      }
      await NodeTimersPromises.setTimeout(100);
    }
    if (Date.now() >= deadline)
      throw new Error(`Historical startup did not become ready.\n${output}`);
    await importPackagedHistory(command, cwd, home, port);
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
  for (const version of ["1293-fork.2", "1400-fork.1", "m4-cut"]) {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-history-upgrade-"));
    try {
      const home = NodePath.join(root, "home");
      const workspace = NodePath.join(root, "workspace");
      await NodeFSP.mkdir(NodePath.join(home, "userdata"), { recursive: true });
      await NodeFSP.mkdir(workspace);
      const databasePath = NodePath.join(home, "userdata/state.sqlite");
      const before = await seed(databasePath, workspace, version);
      await boot(command, cwd, home, workspace);
      verify(NodePath.join(home, "userdata/statev2.sqlite"), before);
      // Restart the same database to verify idempotency and rebuilt projections.
      await boot(command, cwd, home, workspace);
      verify(NodePath.join(home, "userdata/statev2.sqlite"), before);
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
