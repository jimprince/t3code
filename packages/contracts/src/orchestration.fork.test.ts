import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";

import {
  ChatAttachment,
  ChatFileHandoffAttachment,
  ClientOrchestrationCommand,
  OrchestrationMessage,
  ThreadMoveBundle,
  ThreadMoveBundleV1,
} from "./orchestration.ts";

// ---------------------------------------------------------------------------
// File handoffs (fork): parallel optional field, distinct from the upstream union member
// ---------------------------------------------------------------------------

const decodeChatFileHandoffAttachment = Schema.decodeUnknownEffect(ChatFileHandoffAttachment);
const decodeClientOrchestrationCommand = Schema.decodeUnknownEffect(ClientOrchestrationCommand);
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

it.effect("ChatFileHandoffAttachment round-trips through the schema", () =>
  Effect.gen(function* () {
    const decoded = yield* decodeChatFileHandoffAttachment(fileAttachmentWire);
    assert.deepStrictEqual(decoded, fileAttachmentWire);
  }),
);

it.effect("OrchestrationMessage carries optional fileAttachments", () =>
  Effect.gen(function* () {
    const decoded = yield* decodeOrchestrationMessage(messageWithFileAttachmentsWire);
    assert.deepStrictEqual(decoded.fileAttachments, [fileAttachmentWire]);
  }),
);

it.effect("client turn start accepts uploaded images alongside file attachments", () =>
  Effect.gen(function* () {
    const decoded = yield* decodeClientOrchestrationCommand({
      type: "thread.turn.start",
      commandId: "command-mixed-attachments",
      threadId: "thread-1",
      message: {
        messageId: "message-mixed-attachments",
        role: "user",
        text: "Review both attachments.",
        attachments: [
          {
            type: "image",
            id: "pending-00000000-0000-4000-8000-000000000001",
            name: "diagram.png",
            mimeType: "image/png",
            sizeBytes: 3,
          },
        ],
        fileAttachments: [
          {
            type: "file",
            name: "report.pdf",
            mimeType: "application/pdf",
            sizeBytes: 3,
            dataUrl: "data:application/pdf;base64,cGRm",
          },
        ],
      },
      runtimeMode: "full-access",
      interactionMode: "default",
      createdAt: "2026-01-01T00:00:00.000Z",
    });

    assert.strictEqual(decoded.type, "thread.turn.start");
    if (decoded.type === "thread.turn.start") {
      assert.deepStrictEqual(decoded.message.attachments[0], {
        type: "image",
        id: "pending-00000000-0000-4000-8000-000000000001",
        name: "diagram.png",
        mimeType: "image/png",
        sizeBytes: 3,
      });
      assert.strictEqual(decoded.message.fileAttachments?.[0]?.name, "report.pdf");
    }
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

it.effect("ChatAttachment keeps upstream file metadata separate from fork handoff paths", () =>
  Effect.gen(function* () {
    const decoded = yield* Schema.decodeUnknownEffect(ChatAttachment)(fileAttachmentWire);
    assert.deepStrictEqual(decoded, {
      type: "file",
      id: fileAttachmentWire.id,
      name: fileAttachmentWire.name,
      mimeType: fileAttachmentWire.mimeType,
      sizeBytes: fileAttachmentWire.sizeBytes,
    });
  }),
);

const threadMoveBundleBase = {
  exportedAt: "2026-01-01T00:00:00.000Z",
  sourceProjectId: "project-1",
  sourceWorkspaceRoot: "/source/project",
  repositoryIdentity: null,
  thread: {
    id: "thread-1",
    title: "Portable thread",
    modelSelection: { instanceId: "codex", model: "gpt-5-codex" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    goal: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    messages: [],
    proposedPlans: [],
    activities: [],
    checkpoints: [],
  },
  git: null,
  providerSession: null,
  warnings: [],
} as const;

it.effect("ThreadMoveBundle accepts v1 and v2 while a strict v1 target rejects v2", () =>
  Effect.gen(function* () {
    const decodeCurrent = Schema.decodeUnknownEffect(ThreadMoveBundle);
    const v1 = { version: 1, ...threadMoveBundleBase } as const;
    const v2 = {
      version: 2,
      ...threadMoveBundleBase,
      attachments: [{ id: "attachment-1", contentBase64: "AAE=" }],
    } as const;

    assert.strictEqual((yield* decodeCurrent(v1)).version, 1);
    assert.strictEqual((yield* decodeCurrent(v2)).version, 2);
    assert.isTrue(
      Exit.isFailure(yield* Effect.exit(Schema.decodeUnknownEffect(ThreadMoveBundleV1)(v2))),
    );
  }),
);
