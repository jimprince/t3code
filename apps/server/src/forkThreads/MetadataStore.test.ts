import { expect, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { listMetadata, readMetadata, writeMetadata } from "./MetadataStore.ts";

it.effect("full listings decode only rows whose payload changed", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const child = ThreadId.make("memo-child");
    const other = ThreadId.make("memo-other");
    yield* writeMetadata(sql, { threadId: child, parentThreadId: null });
    yield* writeMetadata(sql, { threadId: other, parentThreadId: null });

    const first = yield* listMetadata(sql);
    const second = yield* listMetadata(sql);
    // The same decoded rows come back: nothing was decoded again.
    expect(second.every((row, index) => row === first[index])).toBe(true);

    yield* writeMetadata(sql, { threadId: child, parentThreadId: other });
    const third = yield* listMetadata(sql);
    const edited = third.find((row) => row.threadId === child);
    expect(edited?.parentThreadId).toBe(other);
    expect(third.find((row) => row.threadId === other)).toBe(
      first.find((row) => row.threadId === other),
    );
    expect((yield* readMetadata(sql, child))?.parentThreadId).toBe(other);
  }).pipe(Effect.provide(SqlitePersistenceMemory)),
);
