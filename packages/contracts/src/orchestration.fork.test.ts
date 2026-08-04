import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { ChatAttachment, ChatFileAttachment, OrchestrationMessage } from "./orchestration.ts";

// ---------------------------------------------------------------------------
// File attachments (fork): parallel optional field, never a union member
// ---------------------------------------------------------------------------

const decodeChatFileAttachment = Schema.decodeUnknownEffect(ChatFileAttachment);
const decodeOrchestrationMessage = Schema.decodeUnknownEffect(OrchestrationMessage);

const fileAttachmentWire = {
  type: "file" as const,
  id: "thread-1-0d9f0c7e",
  name: "report.pdf",
  mimeType: "application/pdf",
  sizeBytes: 2048,
  path: "/tmp/t3-file-attachments/thread-1-0d9f0c7e/report.pdf",
};

const messageWithFileAttachmentsWire = {
  id: "message-1",
  role: "user",
  text: "Review the attached report.",
  turnId: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  streaming: false,
  fileAttachments: [fileAttachmentWire],
};

it.effect("ChatFileAttachment round-trips through the schema", () =>
  Effect.gen(function* () {
    const decoded = yield* decodeChatFileAttachment(fileAttachmentWire);
    assert.deepStrictEqual(decoded, fileAttachmentWire);
  }),
);

it.effect("OrchestrationMessage carries optional fileAttachments", () =>
  Effect.gen(function* () {
    const decoded = yield* decodeOrchestrationMessage(messageWithFileAttachmentsWire);
    assert.deepStrictEqual(decoded.fileAttachments, [fileAttachmentWire]);
  }),
);

it.effect("old decoders ignore the fileAttachments field instead of failing", () =>
  Effect.gen(function* () {
    // Simulates a pre-fileAttachments client (old mobile build, vendored
    // t3-thread contracts) decoding a projection that carries the new field.
    // Struct decode must drop the unknown key; widening the ChatAttachment
    // union instead would hard-fail here — that is the design constraint
    // this test pins down.
    const LegacyMessage = Schema.Struct({
      id: Schema.String,
      role: Schema.String,
      text: Schema.String,
    });
    const decoded = yield* Schema.decodeUnknownEffect(LegacyMessage)(
      messageWithFileAttachmentsWire,
    );
    assert.deepStrictEqual(decoded, {
      id: "message-1",
      role: "user",
      text: "Review the attached report.",
    });
  }),
);

it.effect("ChatAttachment union still rejects unknown type literals", () =>
  Effect.gen(function* () {
    // Canary for the compat rationale: if someone later widens ChatAttachment
    // with type:"file", old decoders would break — this documents that a
    // "file" member is NOT decodable as a ChatAttachment.
    const result = yield* Effect.exit(
      Schema.decodeUnknownEffect(ChatAttachment)(fileAttachmentWire),
    );
    assert.strictEqual(result._tag, "Failure");
  }),
);
