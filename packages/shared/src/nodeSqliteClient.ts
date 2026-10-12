/**
 * Port of `@effect/sql-sqlite-node` that uses the native `node:sqlite`
 * bindings instead of `better-sqlite3`.
 *
 * By default one in-process connection serves every statement. With `workers`
 * set, a file database instead runs on worker threads: one writer plus a pool
 * of read-only connections, so queries never block the main thread and reads
 * never queue behind writes.
 *
 * @module SqliteClient
 */
import * as NodeSqlite from "node:sqlite";
import * as NodeWorkerThreads from "node:worker_threads";

import * as Cache from "effect/Cache";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import { identity } from "effect/Function";
import * as Layer from "effect/Layer";
import * as Predicate from "effect/Predicate";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Context from "effect/Context";
import * as Stream from "effect/Stream";
import * as Reactivity from "effect/unstable/reactivity/Reactivity";
import * as Client from "effect/unstable/sql/SqlClient";
import type { Connection } from "effect/unstable/sql/SqlConnection";
import { SqlError, classifySqliteError } from "effect/unstable/sql/SqlError";
import * as Statement from "effect/unstable/sql/Statement";

const ATTR_DB_SYSTEM_NAME = "db.system.name";

export interface SqliteClientConfig {
  readonly filename: string;
  readonly readonly?: boolean | undefined;
  readonly allowExtension?: boolean | undefined;
  readonly prepareCacheSize?: number | undefined;
  readonly prepareCacheTTL?: Duration.Input | undefined;
  readonly spanAttributes?: Record<string, unknown> | undefined;
  readonly transformResultNames?: ((str: string) => string) | undefined;
  readonly transformQueryNames?: ((str: string) => string) | undefined;
  /**
   * Run a file database on worker threads: one writer and `readers` read-only
   * connections. The writer switches the database to WAL so readers see
   * committed data without waiting for it.
   */
  readonly workers?:
    | {
        readonly readers: number;
        readonly busyTimeoutMs?: number | undefined;
      }
    | undefined;
}

export class UnsupportedNodeSqliteVersionError extends Schema.TaggedError<UnsupportedNodeSqliteVersionError>()(
  "UnsupportedNodeSqliteVersionError",
  {
    nodeVersion: Schema.String,
    requirement: Schema.String,
  },
) {
  override get message(): string {
    return `Node.js ${this.nodeVersion} is missing required node:sqlite APIs. Upgrade to ${this.requirement}.`;
  }
}

export class UnsupportedNodeSqliteOperationError extends Schema.TaggedError<UnsupportedNodeSqliteOperationError>()(
  "UnsupportedNodeSqliteOperationError",
  {},
) {
  override get message(): string {
    return "Node SQLite does not support executeStream.";
  }
}

/**
 * Verify that the current Node.js version includes the `node:sqlite` APIs
 * used by `NodeSqliteClient` — specifically `StatementSync.columns()` (added
 * in Node 22.16.0 / 23.11.0).
 *
 * @see https://github.com/nodejs/node/pull/57490
 */
const checkNodeSqliteCompat = () => {
  const parts = process.versions.node.split(".").map(Number);
  const major = parts[0] ?? 0;
  const minor = parts[1] ?? 0;
  const supported = (major === 22 && minor >= 16) || (major === 23 && minor >= 11) || major >= 24;

  if (!supported) {
    return Effect.die(
      new UnsupportedNodeSqliteVersionError({
        nodeVersion: process.versions.node,
        requirement: "Node.js >=22.16, >=23.11, or >=24",
      }),
    );
  }
  return Effect.void;
};

/**
 * `node:sqlite` reports the SQLite result code as `errcode`, while
 * `classifySqliteError` reads `errno`. Copy it across so busy, locked and
 * constraint failures get their own reasons instead of `UnknownError`.
 */
const classifyError = (cause: unknown, message: string, operation: string) => {
  if (
    Predicate.hasProperty(cause, "errcode") &&
    typeof cause.errcode === "number" &&
    !Predicate.hasProperty(cause, "errno")
  ) {
    Object.assign(cause, { errno: cause.errcode });
  }
  return classifySqliteError(cause, { message, operation });
};

type WorkerPhase = "open" | "prepare" | "execute";
type WorkerResultMode = "rows" | "raw" | "values";

interface WorkerRequest {
  readonly id: number;
  readonly type: "run" | "close";
  readonly sql?: string;
  readonly params?: ReadonlyArray<unknown>;
  readonly mode?: WorkerResultMode;
  readonly cached?: boolean;
  readonly safeIntegers?: boolean;
}

interface WorkerFailure {
  readonly phase: WorkerPhase;
  readonly message: string;
  readonly code?: string;
  readonly errcode?: number;
  readonly errstr?: string;
}

type WorkerReply =
  | { readonly id: number; readonly ok: true; readonly result: unknown }
  | { readonly id: number; readonly ok: false; readonly error: WorkerFailure };

// Runs inside each worker thread. It is a plain CommonJS string because the
// server ships as a single executable, where a separate worker file would not
// exist on disk. Reply 0 reports whether the database opened.
const WORKER_SOURCE = `
"use strict";
const { parentPort, workerData } = require("node:worker_threads");
const { DatabaseSync } = require("node:sqlite");

const failure = (phase, cause) => ({
  phase,
  message: String(cause && cause.message !== undefined ? cause.message : cause),
  code: cause ? cause.code : undefined,
  errcode: cause ? cause.errcode : undefined,
  errstr: cause ? cause.errstr : undefined,
});

const serve = (db) => {
  const cache = new Map();
  const prepare = (sql, cached) => {
    if (!cached) {
      const statement = db.prepare(sql);
      return { statement, hasRows: statement.columns().length > 0 };
    }
    let entry = cache.get(sql);
    if (entry !== undefined) {
      cache.delete(sql);
      cache.set(sql, entry);
      return entry;
    }
    const statement = db.prepare(sql);
    entry = { statement, hasRows: statement.columns().length > 0 };
    cache.set(sql, entry);
    if (cache.size > workerData.prepareCacheSize) cache.delete(cache.keys().next().value);
    return entry;
  };

  parentPort.on("message", (request) => {
    if (request.type === "close") {
      db.close();
      parentPort.postMessage({ id: request.id, ok: true, result: null });
      return;
    }
    let entry;
    try {
      entry = prepare(request.sql, request.cached);
    } catch (cause) {
      parentPort.postMessage({ id: request.id, ok: false, error: failure("prepare", cause) });
      return;
    }
    try {
      const statement = entry.statement;
      statement.setReadBigInts(request.safeIntegers);
      let result;
      if (entry.hasRows) {
        statement.setReturnArrays(request.mode === "values");
        result = statement.all(...request.params);
      } else {
        const info = statement.run(...request.params);
        result = request.mode === "raw" ? info : [];
      }
      parentPort.postMessage({ id: request.id, ok: true, result });
    } catch (cause) {
      parentPort.postMessage({ id: request.id, ok: false, error: failure("execute", cause) });
    }
  });
};

let db;
try {
  db = new DatabaseSync(workerData.filename, {
    readOnly: workerData.readonly,
    allowExtension: workerData.allowExtension,
  });
  for (const pragma of workerData.pragmas) db.exec(pragma);
} catch (cause) {
  if (db !== undefined) db.close();
  db = undefined;
  parentPort.postMessage({ id: 0, ok: false, error: failure("open", cause) });
}
if (db !== undefined) {
  serve(db);
  parentPort.postMessage({ id: 0, ok: true, result: null });
}
`;

const PHASE_MESSAGES: Record<WorkerPhase, string> = {
  open: "Failed to open database",
  prepare: "Failed to prepare statement",
  execute: "Failed to execute statement",
};

const toSqlError = (failure: WorkerFailure) =>
  new SqlError({
    reason: classifyError(
      Object.assign(new Error(failure.message), {
        code: failure.code,
        errcode: failure.errcode,
        errstr: failure.errstr,
      }),
      PHASE_MESSAGES[failure.phase],
      failure.phase,
    ),
  });

const SQLITE_READONLY = 8;

// A read-only connection rejects a write before it changes anything.
const isReadonlyRejection = (error: SqlError) => {
  const cause: unknown = error.reason.cause;
  return (
    Predicate.hasProperty(cause, "errcode") &&
    typeof cause.errcode === "number" &&
    (cause.errcode & 0xff) === SQLITE_READONLY
  );
};

// Statements that can run on a reader. A write that slips through (for
// example a WITH ... INSERT) is rejected there and retried on the writer.
const READ_STATEMENT = /^(?:\s|--[^\n]*\n|\/\*[\s\S]*?\*\/)*(?:SELECT|WITH|VALUES)\b/i;

/**
 * One `node:sqlite` connection on its own worker thread. Statements run in the
 * order they are sent. The worker only keeps the process alive while a
 * statement is in flight.
 */
const makeWorkerConnection = Effect.fnUntraced(function* (
  options: SqliteClientConfig,
  role: { readonly readonly: boolean; readonly pragmas: ReadonlyArray<string> },
) {
  const worker = yield* Effect.acquireRelease(
    Effect.callback<NodeWorkerThreads.Worker, SqlError>((resume) => {
      const worker = new NodeWorkerThreads.Worker(WORKER_SOURCE, {
        eval: true,
        workerData: {
          filename: options.filename,
          readonly: role.readonly,
          allowExtension: options.allowExtension ?? false,
          pragmas: role.pragmas,
          prepareCacheSize: options.prepareCacheSize ?? 200,
        },
      });
      const cleanup = () => {
        worker.off("message", onReady);
        worker.off("error", onError);
      };
      const onReady = (reply: WorkerReply) => {
        cleanup();
        if (reply.ok) {
          resume(Effect.succeed(worker));
          return;
        }
        void worker.terminate();
        resume(Effect.fail(toSqlError(reply.error)));
      };
      const onError = (cause: unknown) => {
        cleanup();
        resume(
          Effect.fail(new SqlError({ reason: classifyError(cause, PHASE_MESSAGES.open, "open") })),
        );
      };
      worker.on("message", onReady);
      worker.on("error", onError);
      return Effect.sync(() => {
        cleanup();
        void worker.terminate();
      });
    }),
    (worker) =>
      Effect.ignore(request({ type: "close" })).pipe(
        Effect.andThen(Effect.promise(() => worker.terminate())),
      ),
  );

  const pending = new Map<number, (reply: WorkerReply) => void>();
  let nextId = 1;
  let stopped: SqlError | undefined;
  const settle = (id: number) => {
    pending.delete(id);
    if (pending.size === 0) worker.unref();
  };
  worker.unref();
  worker.on("message", (reply: WorkerReply) => {
    const resolve = pending.get(reply.id);
    if (resolve === undefined) return;
    settle(reply.id);
    resolve(reply);
  });
  const stop = (cause: unknown) => {
    stopped ??= new SqlError({
      reason: classifyError(cause, "SQLite worker stopped", "execute"),
    });
    const waiting = Array.from(pending.entries());
    pending.clear();
    for (const [id, resolve] of waiting) {
      resolve({ id, ok: false, error: { phase: "execute", message: "SQLite worker stopped" } });
    }
  };
  worker.on("error", stop);
  worker.on("exit", (code) => stop(new Error(`SQLite worker exited with code ${code}`)));

  function request(message: Omit<WorkerRequest, "id">) {
    return Effect.callback<unknown, SqlError>((resume) => {
      if (stopped !== undefined) {
        resume(Effect.fail(stopped));
        return;
      }
      const id = nextId++;
      pending.set(id, (reply) =>
        resume(reply.ok ? Effect.succeed(reply.result) : Effect.fail(toSqlError(reply.error))),
      );
      if (pending.size === 1) worker.ref();
      worker.postMessage({ ...message, id } satisfies WorkerRequest);
      // The worker still finishes an interrupted statement; its reply is dropped.
      return Effect.sync(() => settle(id));
    });
  }

  const run = (
    sql: string,
    params: ReadonlyArray<unknown>,
    mode: WorkerResultMode,
    cached: boolean,
  ): Effect.Effect<ReadonlyArray<any>, SqlError> =>
    Effect.withFiber((fiber) =>
      request({
        type: "run",
        sql,
        params,
        mode,
        cached,
        safeIntegers: Boolean(Context.get(fiber.context, Client.SafeIntegers)),
      }),
    ) as Effect.Effect<ReadonlyArray<any>, SqlError>;

  return identity<Connection>({
    execute(sql, params, rowTransform) {
      const rows = run(sql, params, "rows", true);
      return rowTransform ? Effect.map(rows, rowTransform) : rows;
    },
    executeRaw(sql, params) {
      return run(sql, params, "raw", true);
    },
    executeValues(sql, params) {
      return run(sql, params, "values", true) as Effect.Effect<
        ReadonlyArray<ReadonlyArray<unknown>>,
        SqlError
      >;
    },
    executeValuesUnprepared(sql, params) {
      return run(sql, params ?? [], "values", false) as Effect.Effect<
        ReadonlyArray<ReadonlyArray<unknown>>,
        SqlError
      >;
    },
    executeUnprepared(sql, params, rowTransform) {
      const rows = run(sql, params ?? [], "rows", false);
      return rowTransform ? Effect.map(rows, rowTransform) : rows;
    },
    executeStream(_sql, _params) {
      return Stream.die(new UnsupportedNodeSqliteOperationError());
    },
  });
});

// Set only while `withReadTransaction` acquires its connection.
const ReadSnapshot = Context.Reference<boolean>("t3/sqlite/ReadSnapshot", {
  defaultValue: () => false,
});

/**
 * Run `effect` as one consistent, read-only snapshot. On a worker-backed
 * client it uses a reader connection: it waits for a write transaction that is
 * already open, like any read, but never blocks the writer while it runs, and
 * a write inside it fails. Inside an open transaction it joins that
 * transaction, and nested transactions join the snapshot. Without workers it
 * is an ordinary transaction.
 */
export const withReadTransaction =
  (sql: Client.SqlClient) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E | SqlError, R> =>
    sql
      .withTransaction(Effect.provideService(effect, ReadSnapshot, false))
      .pipe(Effect.provideService(ReadSnapshot, true));

const make = Effect.fn("makeWithDatabase")(function* (
  options: SqliteClientConfig,
): Effect.fn.Return<Client.SqlClient, SqlError, Scope.Scope | Reactivity.Reactivity> {
  yield* checkNodeSqliteCompat();

  const compiler = Statement.makeCompilerSqlite(options.transformQueryNames);
  const transformRows = options.transformResultNames
    ? Statement.defaultTransforms(options.transformResultNames).array
    : undefined;

  const makeConnection = Effect.gen(function* () {
    const scope = yield* Effect.scope;
    const db = yield* Effect.try({
      try: () =>
        new NodeSqlite.DatabaseSync(options.filename, {
          readOnly: options.readonly ?? false,
          allowExtension: options.allowExtension ?? false,
        }),
      catch: (cause) =>
        new SqlError({
          reason: classifyError(cause, "Failed to open database", "open"),
        }),
    });
    yield* Scope.addFinalizer(
      scope,
      Effect.try({
        try: () => db.close(),
        catch: (cause) =>
          new SqlError({
            reason: classifyError(cause, "Failed to close database", "close"),
          }),
      }).pipe(Effect.orDie),
    );

    const statementReaderCache = new WeakMap<NodeSqlite.StatementSync, boolean>();
    const hasRows = (statement: NodeSqlite.StatementSync): boolean => {
      const cached = statementReaderCache.get(statement);
      if (cached !== undefined) {
        return cached;
      }
      const value = statement.columns().length > 0;
      statementReaderCache.set(statement, value);
      return value;
    };

    const prepare = (sql: string) =>
      Effect.try({
        try: () => db.prepare(sql),
        catch: (cause) =>
          new SqlError({
            reason: classifyError(cause, "Failed to prepare statement", "prepare"),
          }),
      });

    const prepareCache = yield* Cache.makeWith(prepare, {
      capacity: options.prepareCacheSize ?? 200,
      // A transient prepare failure must not outlive the lock or missing schema.
      timeToLive: (exit) =>
        Exit.isSuccess(exit) ? (options.prepareCacheTTL ?? Duration.minutes(10)) : Duration.zero,
    });

    const runStatement = (
      statement: NodeSqlite.StatementSync,
      params: ReadonlyArray<unknown>,
      raw: boolean,
    ) =>
      Effect.withFiber<ReadonlyArray<any>, SqlError>((fiber) => {
        try {
          statement.setReadBigInts(Boolean(Context.get(fiber.context, Client.SafeIntegers)));
          if (hasRows(statement)) {
            return Effect.succeed(statement.all(...(params as any)));
          }
          const result = statement.run(...(params as any));
          return Effect.succeed(raw ? (result as unknown as ReadonlyArray<any>) : []);
        } catch (cause) {
          return Effect.fail(
            new SqlError({
              reason: classifyError(cause, "Failed to execute statement", "execute"),
            }),
          );
        }
      });

    const run = (sql: string, params: ReadonlyArray<unknown>, raw = false) =>
      Effect.flatMap(Cache.get(prepareCache, sql), (s) => runStatement(s, params, raw));

    const runStatementValues = (
      statement: NodeSqlite.StatementSync,
      params: ReadonlyArray<unknown>,
    ) =>
      Effect.acquireUseRelease(
        Effect.succeed(statement),
        (statement) =>
          Effect.try({
            try: () => {
              if (hasRows(statement)) {
                statement.setReturnArrays(true);
                // Safe to cast to array after we've setReturnArrays(true)
                return statement.all(...(params as any)) as unknown as ReadonlyArray<
                  ReadonlyArray<unknown>
                >;
              }
              statement.run(...(params as any));
              return [];
            },
            catch: (cause) =>
              new SqlError({
                reason: classifyError(cause, "Failed to execute statement", "execute"),
              }),
          }),
        (statement) =>
          Effect.try({
            try: () => {
              if (hasRows(statement)) {
                statement.setReturnArrays(false);
              }
            },
            catch: (cause) =>
              new SqlError({
                reason: classifyError(
                  cause,
                  "Failed to reset statement result mode",
                  "resetResultMode",
                ),
              }),
          }).pipe(Effect.orDie),
      );

    const runValues = (sql: string, params: ReadonlyArray<unknown>) =>
      Effect.flatMap(Cache.get(prepareCache, sql), (statement) =>
        runStatementValues(statement, params),
      );

    return identity<Connection>({
      execute(sql, params, rowTransform) {
        return rowTransform ? Effect.map(run(sql, params), rowTransform) : run(sql, params);
      },
      executeRaw(sql, params) {
        return run(sql, params, true);
      },
      executeValues(sql, params) {
        return runValues(sql, params);
      },
      executeValuesUnprepared(sql, params) {
        return Effect.flatMap(prepare(sql), (statement) =>
          runStatementValues(statement, params ?? []),
        );
      },
      executeUnprepared(sql, params, rowTransform) {
        const effect = prepare(sql).pipe(
          Effect.flatMap((statement) => runStatement(statement, params ?? [], false)),
        );
        return rowTransform ? Effect.map(effect, rowTransform) : effect;
      },
      executeStream(_sql, _params) {
        return Stream.die(new UnsupportedNodeSqliteOperationError());
      },
    });
  });

  const semaphore = yield* Semaphore.make(1);
  // Keeps `connection` to the caller until the caller's scope closes.
  const holdConnection = (connection: Connection) =>
    Effect.uninterruptibleMask((restore) => {
      const fiber = Fiber.getCurrent()!;
      const scope = Context.getUnsafe(fiber.context, Scope.Scope);
      return Effect.as(
        Effect.tap(restore(semaphore.take(1)), () =>
          Scope.addFinalizer(scope, semaphore.release(1)),
        ),
        connection,
      );
    });
  const control = (connection: Connection, sql: string) =>
    Effect.asVoid(connection.executeUnprepared(sql, [], undefined));

  let acquirer: Effect.Effect<Connection, SqlError, Scope.Scope>;
  let transactionAcquirer: Effect.Effect<Connection, SqlError, Scope.Scope>;

  if (options.workers === undefined) {
    const connection = yield* makeConnection;
    acquirer = semaphore.withPermits(1)(Effect.succeed(connection));
    // The only connection is the writer, so a read snapshot is an ordinary
    // transaction on it.
    transactionAcquirer = holdConnection(connection);
  } else {
    const busyTimeout = `PRAGMA busy_timeout = ${options.workers.busyTimeoutMs ?? 5000}`;
    // WAL before any reader opens, so readers never block the writer.
    const writer = yield* makeWorkerConnection(options, {
      readonly: false,
      pragmas: [busyTimeout, "PRAGMA journal_mode = WAL"],
    });
    const readers = yield* Effect.forEach(
      Array.from({ length: Math.max(1, options.workers.readers) }),
      () => makeWorkerConnection(options, { readonly: true, pragmas: [busyTimeout] }),
      { concurrency: "unbounded" },
    );
    const idleReaders = yield* Queue.unbounded<Connection>();
    yield* Queue.offerAll(idleReaders, readers);
    const acquireReader = Effect.acquireRelease(Queue.take(idleReaders), (reader) =>
      Queue.offer(idleReaders, reader),
    );
    // A read first waits for any write transaction already open, as it would on
    // one shared connection, so it sees every write that started before it.
    // Callers rely on that order: a check made right after a command must see
    // the command's writes. Only the wait is shared; the read runs on a reader.
    const afterOpenWrites = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      Effect.andThen(semaphore.withPermits(1)(Effect.void), effect);

    // Outside a transaction a statement holds the writer until it finishes, so
    // it can never land inside another fiber's open transaction.
    const route = <A>(sql: string, run: (connection: Connection) => Effect.Effect<A, SqlError>) => {
      const onWriter = semaphore.withPermits(1)(run(writer));
      return READ_STATEMENT.test(sql)
        ? afterOpenWrites(Effect.scoped(Effect.flatMap(acquireReader, run))).pipe(
            Effect.catchIf(isReadonlyRejection, () => onWriter),
          )
        : onWriter;
    };
    // The client begins every transaction with BEGIN IMMEDIATE. A snapshot
    // never writes, so it begins deferred, and SQLite fixes the snapshot at its
    // first read. Making that read while holding the writer puts every open
    // write in the snapshot; the writer is free again before the real reads.
    const beginSnapshot = (reader: Connection): Connection => ({
      ...reader,
      executeUnprepared: (sql, params, rowTransform) =>
        sql === "BEGIN IMMEDIATE"
          ? semaphore.withPermits(1)(
              Effect.andThen(
                control(reader, "BEGIN"),
                reader.executeUnprepared("SELECT 1 FROM sqlite_schema LIMIT 1", [], rowTransform),
              ),
            )
          : reader.executeUnprepared(sql, params, rowTransform),
    });
    const router = identity<Connection>({
      execute: (sql, params, rowTransform) =>
        route(sql, (connection) => connection.execute(sql, params, rowTransform)),
      executeRaw: (sql, params) => route(sql, (connection) => connection.executeRaw(sql, params)),
      executeValues: (sql, params) =>
        route(sql, (connection) => connection.executeValues(sql, params)),
      executeValuesUnprepared: (sql, params) =>
        route(sql, (connection) => connection.executeValuesUnprepared(sql, params)),
      executeUnprepared: (sql, params, rowTransform) =>
        route(sql, (connection) => connection.executeUnprepared(sql, params, rowTransform)),
      executeStream: (_sql, _params) => Stream.die(new UnsupportedNodeSqliteOperationError()),
    });
    acquirer = Effect.succeed(router);
    const writeAcquirer = holdConnection(writer);
    transactionAcquirer = Effect.withFiber((fiber) =>
      Context.get(fiber.context, ReadSnapshot)
        ? Effect.map(acquireReader, beginSnapshot)
        : writeAcquirer,
    );
  }

  return yield* Client.make({
    acquirer,
    compiler,
    transactionAcquirer,
    // A deferred BEGIN only takes the write lock at the first write. If another
    // process commits after this transaction's first read, that write fails at
    // once with SQLITE_BUSY_SNAPSHOT, which busy_timeout cannot wait out. Taking
    // the lock up front makes it wait instead, at the cost of serializing
    // read-only transactions behind other processes' writers. Read-only
    // connections cannot write, so they keep the deferred BEGIN.
    beginTransaction: options.readonly === true ? "BEGIN" : "BEGIN IMMEDIATE",
    spanAttributes: [
      ...(options.spanAttributes ? Object.entries(options.spanAttributes) : []),
      [ATTR_DB_SYSTEM_NAME, "sqlite"],
    ],
    transformRows,
  });
});

export const layer = (config: SqliteClientConfig): Layer.Layer<Client.SqlClient, SqlError> =>
  Layer.effect(Client.SqlClient, make(config)).pipe(Layer.provide(Reactivity.layer));
