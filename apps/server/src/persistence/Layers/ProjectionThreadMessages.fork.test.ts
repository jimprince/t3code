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
