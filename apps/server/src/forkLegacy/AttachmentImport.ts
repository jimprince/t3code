// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeCrypto from "node:crypto";
import * as NodePath from "node:path";
import {
  ChatAttachment,
  ChatAttachmentId,
  type ChatAttachment as Attachment,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as ServerConfig from "../config.ts";
import {
  attachmentFileExtension,
  createDeterministicAttachmentId,
  resolveAttachmentPath,
} from "../attachmentStore.ts";
import { decodeHistoricalAttachments } from "./AttachmentDecoder.ts";
const decode = Schema.decodeUnknownOption(ChatAttachment);
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
interface LegacyRow {
  readonly message_id: string;
  readonly thread_id: string;
  readonly attachments_json: string | null;
}
function legacyMembers(json: string | null): unknown[] {
  try {
    const value: unknown = JSON.parse(json ?? "[]");
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
/** Recover old temp objects on transcript access. Deterministic ids make interrupted imports restartable; source files are never moved or removed. */
export const makeHistoricalAttachmentRecovery = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const config = yield* Effect.serviceOption(ServerConfig.ServerConfig);
  return Effect.fn("forkLegacy.recoverHistoricalAttachmentRows")(function* <A extends LegacyRow>(
    rows: readonly A[],
  ) {
    const columns = yield* sql<{ name: string }>`PRAGMA table_info(projection_thread_messages)`;
    const hasLegacyFiles = columns.some((c) => c.name === "file_attachments_json");
    return yield* Effect.forEach(rows, (row) =>
      Effect.gen(function* () {
        const attachments = decodeHistoricalAttachments(row.attachments_json);
        if (hasLegacyFiles) {
          const files = yield* sql<{
            file_attachments_json: string | null;
          }>`SELECT file_attachments_json FROM projection_thread_messages WHERE message_id = ${row.message_id}`;
          for (const item of legacyMembers(files[0]?.file_attachments_json ?? null)) {
            if (!record(item)) continue;
            const decoded = decode({ ...item, type: "file" });
            if (Option.isNone(decoded)) continue;
            const original = decoded.value;
            if (attachments.some((a) => a.id === original.id)) continue;
            let recovered: Attachment = {
              ...original,
              type: "legacy-missing",
              name: `${original.name.slice(0, 241)} (unavailable)`,
            };
            if (typeof item.path === "string" && Option.isSome(config)) {
              const extension = attachmentFileExtension(original.name);
              const stableId = createDeterministicAttachmentId(
                row.thread_id,
                `${row.message_id}:${original.id}`,
              );
              if (stableId) {
                const native: Attachment = {
                  ...original,
                  id: ChatAttachmentId.make(
                    `${stableId}${extension === ".bin" ? "-bin" : "-" + extension.slice(1)}`,
                  ),
                };
                const destination = resolveAttachmentPath({
                  attachmentsDir: config.value.attachmentsDir,
                  attachment: native,
                });
                if (destination) {
                  const available = yield* Effect.tryPromise({
                    try: async () => {
                      await NodeFSP.mkdir(NodePath.dirname(destination), { recursive: true });
                      try {
                        const stored = await NodeFSP.stat(destination);
                        if (stored.isFile() && stored.size === original.sizeBytes) return true;
                      } catch {
                        /* First access. */
                      }
                      const source = await NodeFSP.stat(item.path as string);
                      if (!source.isFile() || source.size !== original.sizeBytes) return false;
                      const bytes = await NodeFSP.readFile(item.path as string);
                      if (bytes.length !== original.sizeBytes) return false;
                      const temporary = `${destination}.${NodeCrypto.randomUUID()}.part`;
                      const handle = await NodeFSP.open(temporary, "wx");
                      try {
                        await handle.writeFile(bytes);
                        await handle.close();
                        await NodeFSP.rename(temporary, destination);
                      } finally {
                        await handle.close().catch(() => {});
                        await NodeFSP.rm(temporary, { force: true });
                      }
                      return true;
                    },
                    catch: () => false,
                  }).pipe(Effect.catch(() => Effect.succeed(false)));
                  if (available) recovered = native;
                }
              }
            }
            attachments.push(recovered);
          }
        }
        return { ...row, attachments_json: encodeJson(attachments) };
      }),
    );
  });
});
