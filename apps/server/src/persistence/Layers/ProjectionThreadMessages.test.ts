import { MessageId, ThreadId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { ProjectionThreadMessageRepository } from "../Services/ProjectionThreadMessages.ts";
import { ProjectionThreadMessageRepositoryLive } from "./ProjectionThreadMessages.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";

const layer = it.layer(
  ProjectionThreadMessageRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);

layer("ProjectionThreadMessageRepository", (it) => {
  it.effect("preserves existing attachments when upsert omits attachments", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectionThreadMessageRepository;
      const threadId = ThreadId.make("thread-preserve-attachments");
      const messageId = MessageId.make("message-preserve-attachments");
      const createdAt = "2026-02-28T19:00:00.000Z";
      const updatedAt = "2026-02-28T19:00:01.000Z";
      const persistedAttachments = [
        {
          type: "image" as const,
          id: "thread-preserve-attachments-att-1",
          name: "example.png",
          mimeType: "image/png",
          sizeBytes: 5,
        },
      ];

      yield* repository.upsert({
        messageId,
        threadId,
        turnId: null,
        role: "user",
        text: "initial",
        attachments: persistedAttachments,
        isStreaming: false,
        createdAt,
        updatedAt,
      });

      yield* repository.upsert({
        messageId,
        threadId,
        turnId: null,
        role: "user",
        text: "updated",
        isStreaming: false,
        createdAt,
        updatedAt: "2026-02-28T19:00:02.000Z",
      });

      const rows = yield* repository.listByThreadId({ threadId });
      assert.equal(rows.length, 1);
      assert.equal(rows[0]?.text, "updated");
      assert.deepEqual(rows[0]?.attachments, persistedAttachments);

      const rowById = yield* repository.getByMessageId({ messageId });
      assert.equal(rowById._tag, "Some");
      if (rowById._tag === "Some") {
        assert.equal(rowById.value.text, "updated");
        assert.deepEqual(rowById.value.attachments, persistedAttachments);
      }
    }),
  );

  it.effect("allows explicit attachment clearing with an empty array", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectionThreadMessageRepository;
      const threadId = ThreadId.make("thread-clear-attachments");
      const messageId = MessageId.make("message-clear-attachments");
      const createdAt = "2026-02-28T19:10:00.000Z";

      yield* repository.upsert({
        messageId,
        threadId,
        turnId: null,
        role: "assistant",
        text: "with attachment",
        attachments: [
          {
            type: "image",
            id: "thread-clear-attachments-att-1",
            name: "example.png",
            mimeType: "image/png",
            sizeBytes: 5,
          },
        ],
        isStreaming: false,
        createdAt,
        updatedAt: "2026-02-28T19:10:01.000Z",
      });

      yield* repository.upsert({
        messageId,
        threadId,
        turnId: null,
        role: "assistant",
        text: "cleared",
        attachments: [],
        isStreaming: false,
        createdAt,
        updatedAt: "2026-02-28T19:10:02.000Z",
      });

      const rows = yield* repository.listByThreadId({ threadId });
      assert.equal(rows.length, 1);
      assert.equal(rows[0]?.text, "cleared");
      assert.deepEqual(rows[0]?.attachments, []);
    }),
  );
});

layer("ProjectionThreadMessageRepository fileAttachments", (it) => {
  it.effect("round-trips file attachments through the projection store", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectionThreadMessageRepository;
      const threadId = ThreadId.make("thread-file-attachments");
      const messageId = MessageId.make("message-file-attachments");
      const fileAttachments = [
        {
          type: "file" as const,
          id: "thread-file-attachments-att-1",
          name: "report.pdf",
          mimeType: "application/pdf",
          sizeBytes: 2048,
          path: "/tmp/t3-file-attachments/thread-file-attachments-att-1/report.pdf",
        },
      ];

      // REGRESSION: the projection store persists messages column-wise; a
      // message field that is not mapped to a column silently vanishes on
      // re-read (the agent then never sees the attached file's path).
      yield* repository.upsert({
        messageId,
        threadId,
        turnId: null,
        role: "user",
        text: "use the attached file",
        attachments: [],
        fileAttachments,
        isStreaming: false,
        createdAt: "2026-08-04T20:00:00.000Z",
        updatedAt: "2026-08-04T20:00:00.000Z",
      });

      const rows = yield* repository.listByThreadId({ threadId });
      assert.equal(rows.length, 1);
      assert.deepEqual(rows[0]?.fileAttachments, fileAttachments);

      // Streaming-style upserts that omit the field must preserve it.
      yield* repository.upsert({
        messageId,
        threadId,
        turnId: null,
        role: "user",
        text: "use the attached file",
        isStreaming: false,
        createdAt: "2026-08-04T20:00:00.000Z",
        updatedAt: "2026-08-04T20:00:01.000Z",
      });
      const preserved = yield* repository.getByMessageId({ messageId });
      assert.equal(preserved._tag, "Some");
      if (preserved._tag === "Some") {
        assert.deepEqual(preserved.value.fileAttachments, fileAttachments);
      }
    }),
  );
});
