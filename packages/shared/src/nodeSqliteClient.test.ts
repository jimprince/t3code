import * as NodeSqlite from "node:sqlite";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as SqliteClient from "./nodeSqliteClient.ts";

const makeTempFilename = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-sqlite-workers-" });
  return path.join(directory, "state.sqlite");
});

const workerLayer = Layer.unwrap(
  Effect.map(makeTempFilename, (filename) =>
    SqliteClient.layer({ filename, workers: { readers: 2 } }),
  ),
).pipe(Layer.provide(NodeServices.layer));

const clients = [
  ["in-process", SqliteClient.layer({ filename: ":memory:" })],
  ["worker", workerLayer],
] as const;

for (const [name, clientLayer] of clients) {
  it.layer(clientLayer)(`NodeSqliteClient (${name})`, (it) => {
    it.effect("retries preparing a query after the missing schema becomes available", () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const select = sql<{ name: string }>`SELECT name FROM created_after_prepare_failure`;
        const error = yield* select.pipe(Effect.flip);
        assert.equal(error._tag, "SqlError");
        assert.equal(error.reason.operation, "prepare");

        yield* sql`CREATE TABLE created_after_prepare_failure(name TEXT NOT NULL)`;
        yield* sql`INSERT INTO created_after_prepare_failure VALUES ('recovered')`;
        assert.deepEqual(yield* select, [{ name: "recovered" }]);
        assert.deepEqual(yield* select.values, [["recovered"]]);
      }),
    );

    it.effect("runs prepared queries and returns positional values", () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;

        yield* sql`CREATE TABLE entries(id INTEGER PRIMARY KEY, name TEXT NOT NULL)`;
        yield* sql`INSERT INTO entries(name) VALUES (${"alpha"}), (${"beta"})`;

        const rows = yield* sql<{ readonly id: number; readonly name: string }>`
      SELECT id, name FROM entries ORDER BY id
    `;
        assert.equal(rows.length, 2);
        assert.equal(rows[0]?.name, "alpha");
        assert.equal(rows[1]?.name, "beta");

        const values = yield* sql`SELECT id, name FROM entries ORDER BY id`.values;
        assert.equal(values.length, 2);
        assert.equal(values[0]?.[1], "alpha");
        assert.equal(values[1]?.[1], "beta");

        const unpreparedValues = yield* sql`SELECT id, name FROM entries ORDER BY id`
          .valuesUnprepared;
        assert.deepEqual(unpreparedValues, values);
      }),
    );

    it.effect("returns a typed failure when an unprepared statement cannot be prepared", () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const error = yield* Effect.flip(sql.unsafe("SELECT FROM").unprepared);

        assert.equal(error._tag, "SqlError");
        assert.equal(error.reason.operation, "prepare");
      }),
    );

    it.effect("classifies constraint failures by their SQLite result code", () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`CREATE TABLE constrained(name TEXT NOT NULL UNIQUE)`;
        yield* sql`INSERT INTO constrained VALUES ('taken')`;

        const duplicate = yield* sql`INSERT INTO constrained VALUES ('taken')`.pipe(Effect.flip);
        assert(duplicate.reason._tag === "UniqueViolation");
        assert.equal(duplicate.reason.constraint, "constrained.name");

        const missing = yield* sql`INSERT INTO constrained VALUES (NULL)`.pipe(Effect.flip);
        assert.equal(missing.reason._tag, "ConstraintError");
      }),
    );

    it.effect("joins a nested transaction to the read snapshot around it", () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const rows = yield* SqliteClient.withReadTransaction(sql)(
          sql.withTransaction(sql`SELECT 1 AS value`.values),
        );
        assert.deepEqual(rows, [[1]]);
      }),
    );
  });
}

const workerClient = (filename: string) =>
  SqliteClient.layer({ filename, workers: { readers: 2 } });

it.effect("rejects a write inside a read snapshot and keeps later writes working", () =>
  Effect.gen(function* () {
    const filename = yield* makeTempFilename;
    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TABLE snapshot_writes(name TEXT NOT NULL)`;

      const error = yield* SqliteClient.withReadTransaction(sql)(
        sql`INSERT INTO snapshot_writes VALUES ('rejected')`,
      ).pipe(Effect.flip);
      assert.equal(error._tag, "SqlError");

      yield* sql`INSERT INTO snapshot_writes VALUES ('accepted')`;
      assert.deepEqual(yield* sql`SELECT name FROM snapshot_writes`.values, [["accepted"]]);
    }).pipe(Effect.provide(workerClient(filename)));
  }).pipe(Effect.provide(NodeServices.layer)),
);

// Orchestration checks the projection right after a command and must see that
// command's writes, as it did when every read shared the writer's connection.
it.live("makes reads wait for a write transaction that is already open", () =>
  Effect.gen(function* () {
    const filename = yield* makeTempFilename;
    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TABLE counters(id INTEGER PRIMARY KEY, value INTEGER NOT NULL)`;
      yield* sql`INSERT INTO counters VALUES (1, 0)`;
      const read = sql`SELECT value FROM counters WHERE id = 1`.values;

      const written = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const writer = yield* Effect.forkChild(
        sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`UPDATE counters SET value = 1 WHERE id = 1`;
            yield* Deferred.succeed(written, undefined);
            yield* Deferred.await(release);
          }),
        ),
      );
      yield* Deferred.await(written);

      const plainRead = yield* Effect.forkChild(read);
      const snapshotRead = yield* Effect.forkChild(SqliteClient.withReadTransaction(sql)(read));
      // Without the wait each read answers from a reader within milliseconds.
      const early = yield* Effect.all([Fiber.join(plainRead), Fiber.join(snapshotRead)]).pipe(
        Effect.timeoutOption("200 millis"),
      );
      assert.isTrue(Option.isNone(early));

      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(writer);
      assert.deepEqual(yield* Fiber.join(plainRead), [[1]]);
      assert.deepEqual(yield* Fiber.join(snapshotRead), [[1]]);
    }).pipe(Effect.provide(workerClient(filename)));
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("keeps a read snapshot consistent while the writer commits around it", () =>
  Effect.gen(function* () {
    const filename = yield* makeTempFilename;
    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TABLE counters(id INTEGER PRIMARY KEY, value INTEGER NOT NULL)`;
      yield* sql`INSERT INTO counters VALUES (1, 0)`;
      const read = sql`SELECT value FROM counters WHERE id = 1`.values;

      const firstRead = yield* Deferred.make<void>();
      const committed = yield* Deferred.make<void>();
      const snapshot = yield* Effect.forkChild(
        SqliteClient.withReadTransaction(sql)(
          Effect.gen(function* () {
            const before = yield* read;
            yield* Deferred.succeed(firstRead, undefined);
            yield* Deferred.await(committed);
            return [before, yield* read];
          }),
        ),
      );
      yield* Deferred.await(firstRead);

      // The open snapshot holds up neither the writer nor other reads.
      yield* sql.withTransaction(sql`UPDATE counters SET value = 1 WHERE id = 1`);
      assert.deepEqual(yield* read, [[1]]);
      yield* Deferred.succeed(committed, undefined);

      assert.deepEqual(yield* Fiber.join(snapshot), [[[0]], [[0]]]);
      assert.deepEqual(yield* read, [[1]]);
    }).pipe(Effect.provide(workerClient(filename)));
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("runs a write that starts like a read on the writer", () =>
  Effect.gen(function* () {
    const filename = yield* makeTempFilename;
    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TABLE entries(name TEXT NOT NULL)`;
      yield* sql`WITH incoming(name) AS (VALUES ('routed')) INSERT INTO entries SELECT name FROM incoming`;
      assert.deepEqual(yield* sql`SELECT name FROM entries`.values, [["routed"]]);
    }).pipe(Effect.provide(workerClient(filename)));
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("returns a typed failure when a worker cannot open the database", () =>
  Effect.gen(function* () {
    const error = yield* Effect.flip(
      Layer.build(SqliteClient.layer({ filename: "\0", workers: { readers: 1 } })).pipe(
        Effect.scoped,
      ),
    );

    assert.equal(error._tag, "SqlError");
    assert.equal(error.reason.operation, "open");
  }),
);

const makeTempDatabase = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-sqlite-transaction-" });
  const filename = path.join(directory, "state.sqlite");
  // node:sqlite connections fail a busy statement at once unless given a timeout.
  const other = yield* Effect.acquireRelease(
    Effect.sync(() => new NodeSqlite.DatabaseSync(filename)),
    (database) => Effect.sync(() => database.close()),
  );
  yield* Effect.sync(() => {
    other.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE counters(id INTEGER PRIMARY KEY, value INTEGER NOT NULL);
      INSERT INTO counters VALUES (1, 0);
    `);
  });
  return { filename, other };
});

it.effect("keeps another connection from committing between a transaction's read and write", () =>
  Effect.gen(function* () {
    const { filename, other } = yield* makeTempDatabase;
    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql.withTransaction(
        Effect.gen(function* () {
          const [row] = yield* sql<{ readonly value: number }>`
            SELECT value FROM counters WHERE id = 1
          `;
          // With a deferred BEGIN this commit lands and the write below fails
          // with SQLITE_BUSY_SNAPSHOT, which no busy timeout can wait out.
          yield* Effect.sync(() =>
            assert.throws(
              () => other.exec("UPDATE counters SET value = value + 1 WHERE id = 1"),
              /database is locked/,
            ),
          );
          yield* sql`UPDATE counters SET value = ${(row?.value ?? 0) + 10} WHERE id = 1`;
        }),
      );
      yield* Effect.sync(() => other.exec("UPDATE counters SET value = value + 1 WHERE id = 1"));
      assert.deepEqual(yield* sql`SELECT value FROM counters WHERE id = 1`.values, [[11]]);
    }).pipe(Effect.provide(SqliteClient.layer({ filename })));
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("reports a transaction blocked by another writer as a lock timeout", () =>
  Effect.gen(function* () {
    const { filename, other } = yield* makeTempDatabase;
    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`PRAGMA busy_timeout = 0`;
      const read = sql.withTransaction(sql`SELECT value FROM counters WHERE id = 1`.values);

      yield* Effect.sync(() => other.exec("BEGIN IMMEDIATE"));
      const error = yield* read.pipe(Effect.flip);
      assert.equal(error.reason._tag, "LockTimeoutError");

      yield* Effect.sync(() => other.exec("COMMIT"));
      assert.deepEqual(yield* read, [[0]]);
    }).pipe(Effect.provide(SqliteClient.layer({ filename })));
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("returns a typed failure when the database cannot be opened", () =>
  Effect.gen(function* () {
    const error = yield* Effect.flip(
      Layer.build(SqliteClient.layer({ filename: "\0" })).pipe(Effect.scoped),
    );

    assert.equal(error._tag, "SqlError");
    assert.equal(error.reason.operation, "open");
  }),
);

it.effect(
  "recovers a prepared query immediately after an exclusive database lock is released",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-sqlite-prepare-" });
      const filename = path.join(directory, "state.sqlite");
      const blocker = yield* Effect.acquireRelease(
        Effect.sync(() => new NodeSqlite.DatabaseSync(filename)),
        (database) => Effect.sync(() => database.close()),
      );
      yield* Effect.sync(() => {
        blocker.exec("CREATE TABLE entries(value TEXT); INSERT INTO entries VALUES ('retained')");
      });
      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* Effect.sync(() => blocker.exec("BEGIN EXCLUSIVE"));
        const select = sql`SELECT value FROM entries`;
        const error = yield* select.values.pipe(Effect.flip);
        assert.equal(error._tag, "SqlError");
        assert.equal(error.reason.operation, "prepare");
        yield* Effect.sync(() => blocker.exec("ROLLBACK"));
        assert.deepEqual(yield* select.values, [["retained"]]);
        assert.deepEqual(yield* select, [{ value: "retained" }]);
      }).pipe(Effect.provide(SqliteClient.layer({ filename })));
    }).pipe(Effect.provide(NodeServices.layer)),
);
