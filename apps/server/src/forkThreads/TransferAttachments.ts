// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeCrypto from "node:crypto";
import * as NodePath from "node:path";
import {
  ChatAttachment,
  ChatAttachmentId,
  ThreadId,
  ThreadTransferError,
  type ThreadMoveAttachment,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import * as ServerConfig from "../config.ts";
import {
  resolveAttachmentPath,
  createDeterministicAttachmentId,
  attachmentFileExtension,
} from "../attachmentStore.ts";

const MAX_FILE = 50 * 1024 * 1024;
const MAX_TOTAL = 64 * 1024 * 1024;
const decode = Schema.decodeUnknownOption(ChatAttachment);
export function collectTransferAttachments(value: unknown): Array<ChatAttachment> {
  const found = new Map<string, ChatAttachment>();
  const visit = (input: unknown) => {
    const result = decode(input);
    if (Option.isSome(result)) {
      const previous = found.get(result.value.id);
      if (previous && JSON.stringify(previous) !== JSON.stringify(result.value))
        throw new Error(`Attachment '${result.value.id}' has conflicting metadata.`);
      found.set(result.value.id, result.value);
      return;
    }
    if (Array.isArray(input)) input.forEach(visit);
    else if (Predicate.isObject(input)) Object.values(input).forEach(visit);
  };
  visit(value);
  return [...found.values()];
}
export interface ImportedAttachments {
  readonly attachments: ReadonlyMap<string, ChatAttachment>;
  readonly cleanup: Effect.Effect<void>;
  readonly warnings: ReadonlyArray<string>;
}
export class TransferAttachments extends Context.Service<
  TransferAttachments,
  {
    readonly export: (
      references: ReadonlyArray<ChatAttachment>,
    ) => Effect.Effect<ReadonlyArray<ThreadMoveAttachment>, ThreadTransferError>;
    readonly import: (
      threadId: ThreadId,
      references: ReadonlyArray<ChatAttachment>,
      bytes: ReadonlyArray<ThreadMoveAttachment>,
    ) => Effect.Effect<ImportedAttachments, ThreadTransferError>;
  }
>()("t3/forkThreads/TransferAttachments") {}
const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const exportBytes = (references: ReadonlyArray<ChatAttachment>) =>
    Effect.tryPromise({
      try: async () => {
        let total = 0;
        const result: Array<ThreadMoveAttachment> = [];
        for (const attachment of references) {
          if (attachment.type === "legacy-missing") {
            result.push({ id: attachment.id, contentBase64: null });
            continue;
          }
          const file = resolveAttachmentPath({ attachmentsDir: config.attachmentsDir, attachment });
          if (!file) throw new Error("Invalid attachment storage path.");
          const info = await NodeFSP.stat(file);
          if (
            !info.isFile() ||
            info.size > MAX_FILE ||
            total + info.size > MAX_TOTAL ||
            info.size !== attachment.sizeBytes
          )
            throw new Error("Attachment exceeds byte limit or differs from metadata.");
          const content = await NodeFSP.readFile(file);
          if (content.length !== info.size) throw new Error("Attachment changed during export.");
          total += content.length;
          result.push({ id: attachment.id, contentBase64: content.toString("base64") });
        }
        return result;
      },
      catch: (cause) => new ThreadTransferError({ operation: "export-attachments", cause }),
    });
  const importBytes = (
    threadId: ThreadId,
    references: ReadonlyArray<ChatAttachment>,
    bytes: ReadonlyArray<ThreadMoveAttachment>,
  ) => {
    const owned: Array<string> = [];
    const cleanup = Effect.promise(async () => {
      for (const file of owned) await NodeFSP.unlink(file).catch(() => {});
    });
    return Effect.tryPromise({
      try: async () => {
        let total = 0;
        const attachments = new Map<string, ChatAttachment>();
        const warnings: Array<string> = [];
        const supplied = new Map(bytes.map((item) => [String(item.id), item.contentBase64]));
        if (supplied.size !== bytes.length) throw new Error("Duplicate attachment bytes.");
        for (const original of references) {
          const content = supplied.get(original.id);
          if (content === undefined || content === null) {
            attachments.set(original.id, { ...original, type: "legacy-missing" });
            warnings.push(`Attachment '${original.name}' has no portable bytes.`);
            continue;
          }
          // Buffer's decoder accepts malformed input; bound allocation and require canonical base64.
          if (content.length > 70_000_000) throw new Error("Invalid attachment encoding.");
          const data = Buffer.from(content, "base64");
          if (data.toString("base64") !== content) throw new Error("Invalid attachment encoding.");
          if (
            data.length > MAX_FILE ||
            total + data.length > MAX_TOTAL ||
            data.length !== original.sizeBytes
          )
            throw new Error("Attachment size mismatch or limit exceeded.");
          total += data.length;
          const digest = NodeCrypto.createHash("sha256").update(data).digest("hex");
          const id = createDeterministicAttachmentId(threadId, `${original.id}:${digest}`);
          if (!id) throw new Error("Invalid destination attachment identity.");
          const attachment = {
            ...original,
            id: ChatAttachmentId.make(`${id}-${attachmentFileExtension(original.name).slice(1)}`),
          };
          const destination = resolveAttachmentPath({
            attachmentsDir: config.attachmentsDir,
            attachment,
          });
          if (!destination) throw new Error("Invalid destination attachment path.");
          await NodeFSP.mkdir(NodePath.dirname(destination), { recursive: true });
          try {
            const handle = await NodeFSP.open(destination, "wx");
            owned.push(destination);
            try {
              await handle.writeFile(data);
              await handle.sync();
            } finally {
              await handle.close();
            }
          } catch (error) {
            if (!Predicate.isObject(error) || error.code !== "EEXIST") throw error;
            const existing = await NodeFSP.readFile(destination);
            if (!existing.equals(data))
              throw new Error("Destination attachment collision.", { cause: error });
          }
          attachments.set(original.id, attachment);
        }
        return { attachments, warnings, cleanup };
      },
      catch: (cause) => new ThreadTransferError({ operation: "import-attachments", cause }),
    }).pipe(Effect.onError(() => cleanup));
  };
  return TransferAttachments.of({ export: exportBytes, import: importBytes });
});
export const layer = Layer.effect(TransferAttachments, make);
