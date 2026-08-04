// @effect-diagnostics nodeBuiltinImport:off globalDateInEffect:off
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it, describe, expect } from "@effect/vitest";
import { CHAT_FILE_ATTACHMENT_MAX_BYTES, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

import {
  normalizeUploadFileAttachments,
  sanitizeFileAttachmentName,
  sweepStaleFileAttachments,
} from "./fileAttachmentStore.ts";

const threadId = ThreadId.make("thread-file-attachments");

function toDataUrl(bytes: Uint8Array, mimeType = "application/pdf"): string {
  return `data:${mimeType};base64,${Buffer.from(bytes).toString("base64")}`;
}

const makeTempRoot = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  return yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-file-attachments-test-" });
});

describe("sanitizeFileAttachmentName", () => {
  it("replaces path separators and strips control characters", () => {
    expect(sanitizeFileAttachmentName("a/b\\c.txt")).toBe("a-b-c.txt");
    expect(sanitizeFileAttachmentName("re\u0000port\n.pdf")).toBe("report.pdf");
  });

  it("collapses traversal-only names to the fallback", () => {
    expect(sanitizeFileAttachmentName("..")).toBe("file");
    expect(sanitizeFileAttachmentName(".")).toBe("file");
    expect(sanitizeFileAttachmentName("   ")).toBe("file");
  });

  it("keeps ordinary names including spaces and dotfiles", () => {
    expect(sanitizeFileAttachmentName("my report.pdf")).toBe("my report.pdf");
    expect(sanitizeFileAttachmentName(".env")).toBe(".env");
  });
});

it.layer(NodeServices.layer, { excludeTestServices: true })("fileAttachmentStore", (it) => {
  describe("normalizeUploadFileAttachments", () => {
    it.effect("writes binary payloads under a per-attachment tmp directory", () =>
      Effect.gen(function* () {
        const tmpRoot = yield* makeTempRoot;
        // NUL, high bytes, and an invalid-UTF8 sequence: corrupted by any
        // text-mode write path.
        const bytes = Uint8Array.from([0x00, 0xff, 0x25, 0x50, 0x44, 0x46, 0xc3, 0x28]);

        const normalized = yield* normalizeUploadFileAttachments({
          threadId,
          tmpRoot,
          fileAttachments: [
            {
              type: "file",
              name: "report.pdf",
              mimeType: "application/pdf",
              sizeBytes: bytes.byteLength,
              dataUrl: toDataUrl(bytes),
            },
          ],
        });

        expect(normalized).toHaveLength(1);
        const attachment = normalized[0]!;
        expect(attachment.type).toBe("file");
        expect(attachment.name).toBe("report.pdf");
        expect(attachment.mimeType).toBe("application/pdf");
        expect(attachment.sizeBytes).toBe(bytes.byteLength);
        // Path layout: <tmpRoot>/<attachmentId>/<name>, with the id inside
        // the thread's namespace.
        expect(NodePath.dirname(NodePath.dirname(attachment.path))).toBe(tmpRoot);
        expect(NodePath.basename(attachment.path)).toBe("report.pdf");
        expect(attachment.id).toContain("thread-file-attachments");
        const written = yield* Effect.promise(() => NodeFSP.readFile(attachment.path));
        expect(Buffer.from(written).equals(Buffer.from(bytes))).toBe(true);
      }),
    );

    it.effect("keeps same-named files collision-free via distinct attachment dirs", () =>
      Effect.gen(function* () {
        const tmpRoot = yield* makeTempRoot;
        const upload = (contents: string) => ({
          type: "file" as const,
          name: "notes.txt",
          mimeType: "text/plain",
          sizeBytes: contents.length,
          dataUrl: toDataUrl(new TextEncoder().encode(contents), "text/plain"),
        });

        const normalized = yield* normalizeUploadFileAttachments({
          threadId,
          tmpRoot,
          fileAttachments: [upload("first"), upload("second")],
        });

        expect(normalized).toHaveLength(2);
        expect(normalized[0]!.path).not.toBe(normalized[1]!.path);
        const first = yield* Effect.promise(() => NodeFSP.readFile(normalized[0]!.path, "utf8"));
        const second = yield* Effect.promise(() => NodeFSP.readFile(normalized[1]!.path, "utf8"));
        expect(first).toBe("first");
        expect(second).toBe("second");
      }),
    );

    it.effect("sanitizes traversal attempts in uploaded names", () =>
      Effect.gen(function* () {
        const tmpRoot = yield* makeTempRoot;
        const bytes = Uint8Array.from([0x41]);

        const normalized = yield* normalizeUploadFileAttachments({
          threadId,
          tmpRoot,
          fileAttachments: [
            {
              type: "file",
              name: "../../escape.txt",
              mimeType: "text/plain",
              sizeBytes: bytes.byteLength,
              dataUrl: toDataUrl(bytes, "text/plain"),
            },
          ],
        });

        const attachment = normalized[0]!;
        // The sanitized name keeps no separators, so the file stays inside
        // its attachment directory.
        expect(NodePath.dirname(NodePath.dirname(attachment.path))).toBe(tmpRoot);
        expect(NodePath.basename(attachment.path)).toBe("..-..-escape.txt");
      }),
    );

    it.effect("rejects invalid, empty, and oversized payloads", () =>
      Effect.gen(function* () {
        const tmpRoot = yield* makeTempRoot;
        const base = {
          type: "file" as const,
          name: "x.bin",
          mimeType: "application/octet-stream",
          sizeBytes: 1,
        };

        const invalid = yield* normalizeUploadFileAttachments({
          threadId,
          tmpRoot,
          fileAttachments: [{ ...base, dataUrl: "not-a-data-url" }],
        }).pipe(Effect.flip);
        expect(invalid.message).toContain("Invalid file attachment payload");

        // A zero-byte payload cannot be represented: the data-url parser
        // rejects an empty base64 body outright.
        const empty = yield* normalizeUploadFileAttachments({
          threadId,
          tmpRoot,
          fileAttachments: [{ ...base, dataUrl: "data:application/octet-stream;base64," }],
        }).pipe(Effect.flip);
        expect(empty.message).toContain("Invalid file attachment payload");

        const oversized = Buffer.alloc(CHAT_FILE_ATTACHMENT_MAX_BYTES + 1, 0x61);
        const tooLarge = yield* normalizeUploadFileAttachments({
          threadId,
          tmpRoot,
          fileAttachments: [
            { ...base, sizeBytes: oversized.byteLength, dataUrl: toDataUrl(oversized) },
          ],
        }).pipe(Effect.flip);
        expect(tooLarge.message).toContain("empty or too large");
      }),
    );
  });

  describe("sweepStaleFileAttachments", () => {
    it.effect("removes only entries older than the cutoff", () =>
      Effect.gen(function* () {
        const tmpRoot = yield* makeTempRoot;
        const staleDir = NodePath.join(tmpRoot, "stale-entry");
        const freshDir = NodePath.join(tmpRoot, "fresh-entry");
        yield* Effect.promise(async () => {
          await NodeFSP.mkdir(staleDir, { recursive: true });
          await NodeFSP.writeFile(NodePath.join(staleDir, "old.txt"), "old");
          await NodeFSP.mkdir(freshDir, { recursive: true });
          await NodeFSP.writeFile(NodePath.join(freshDir, "new.txt"), "new");
          const staleTime = new Date(Date.now() - 60 * 60 * 1000);
          await NodeFSP.utimes(staleDir, staleTime, staleTime);
        });

        const removed = yield* sweepStaleFileAttachments(30 * 60 * 1000, tmpRoot);

        expect(removed).toEqual(["stale-entry"]);
        const remaining = yield* Effect.promise(() => NodeFSP.readdir(tmpRoot));
        expect(remaining).toEqual(["fresh-entry"]);
      }),
    );

    it.effect("is a no-op when the root does not exist", () =>
      Effect.gen(function* () {
        const removed = yield* sweepStaleFileAttachments(
          0,
          NodePath.join("/tmp", "t3-file-attachments-missing-root-test"),
        );
        expect(removed).toEqual([]);
      }),
    );
  });
});
