import * as NodeServices from "@effect/platform-node/NodeServices";
import { it, describe, expect } from "@effect/vitest";
import { PROJECT_UPLOAD_FILE_MAX_BYTES } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as WorkspaceEntries from "./WorkspaceEntries.ts";
import * as WorkspaceFileSystem from "./WorkspaceFileSystem.ts";
import * as WorkspacePaths from "./WorkspacePaths.ts";
import * as WorkspaceUploads from "./WorkspaceUploads.ts";

const UploadLayer = WorkspaceUploads.layer.pipe(
  Layer.provide(WorkspacePaths.layer),
  Layer.provide(WorkspaceEntries.layer.pipe(Layer.provide(WorkspacePaths.layer))),
);

const TestLayer = Layer.empty.pipe(
  Layer.provideMerge(UploadLayer),
  Layer.provideMerge(WorkspaceEntries.layer.pipe(Layer.provide(WorkspacePaths.layer))),
  Layer.provideMerge(WorkspacePaths.layer),
  Layer.provideMerge(VcsDriverRegistry.layer.pipe(Layer.provide(VcsProcess.layer))),
  Layer.provide(
    ServerConfig.ServerConfig.layerTest(process.cwd(), {
      prefix: "t3-workspace-uploads-test-",
    }),
  ),
  Layer.provideMerge(NodeServices.layer),
);

const makeTempDir = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  return yield* fileSystem.makeTempDirectoryScoped({
    prefix: "t3code-workspace-uploads-",
  });
});

function toDataUrl(bytes: Uint8Array, mimeType = "application/octet-stream"): string {
  return `data:${mimeType};base64,${Buffer.from(bytes).toString("base64")}`;
}

const writeExistingFile = Effect.fn("writeExistingFile")(function* (
  cwd: string,
  relativePath: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fileSystem.writeFileString(path.join(cwd, relativePath), "existing\n").pipe(Effect.orDie);
});

describe("splitUploadFileName", () => {
  it("splits a conventional name at the last dot", () => {
    expect(WorkspaceUploads.splitUploadFileName("report.final.pdf")).toEqual({
      stem: "report.final",
      ext: ".pdf",
    });
  });

  it("keeps dotfiles whole so renames append after the name", () => {
    expect(WorkspaceUploads.splitUploadFileName(".env")).toEqual({ stem: ".env", ext: "" });
  });

  it("handles extensionless names", () => {
    expect(WorkspaceUploads.splitUploadFileName("Makefile")).toEqual({
      stem: "Makefile",
      ext: "",
    });
  });
});

describe("isInvalidUploadFileName", () => {
  it("rejects separators, traversal, and control characters", () => {
    expect(WorkspaceUploads.isInvalidUploadFileName("a/b.txt")).toBe(true);
    expect(WorkspaceUploads.isInvalidUploadFileName("a\\b.txt")).toBe(true);
    expect(WorkspaceUploads.isInvalidUploadFileName("..")).toBe(true);
    expect(WorkspaceUploads.isInvalidUploadFileName(".")).toBe(true);
    expect(WorkspaceUploads.isInvalidUploadFileName("")).toBe(true);
    expect(WorkspaceUploads.isInvalidUploadFileName("a\u0000b")).toBe(true);
    expect(WorkspaceUploads.isInvalidUploadFileName("a\nb")).toBe(true);
  });

  it("accepts ordinary names including spaces and dotfiles", () => {
    expect(WorkspaceUploads.isInvalidUploadFileName("my report.pdf")).toBe(false);
    expect(WorkspaceUploads.isInvalidUploadFileName(".env")).toBe(false);
  });
});

it.layer(TestLayer, { excludeTestServices: true })("WorkspaceUploadsLive", (it) => {
  describe("uploadFile", () => {
    it.effect("round-trips binary payloads byte-identically", () =>
      Effect.gen(function* () {
        const workspaceUploads = yield* WorkspaceUploads.WorkspaceUploads;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        // Contains NUL, high bytes, and an invalid-UTF8 sequence (0xc3 0x28):
        // a text-only write path would corrupt this payload.
        const bytes = Uint8Array.from([0x00, 0xff, 0x89, 0x50, 0x4e, 0x47, 0xc3, 0x28, 0x00]);

        const result = yield* workspaceUploads.uploadFile({
          cwd,
          fileName: "blob.bin",
          dataUrl: toDataUrl(bytes),
        });

        expect(result).toEqual({ relativePath: "blob.bin", sizeBytes: bytes.byteLength });
        const written = yield* fileSystem.readFile(path.join(cwd, "blob.bin"));
        expect(Buffer.from(written).equals(Buffer.from(bytes))).toBe(true);
      }),
    );

    it.effect("rejects file names containing path separators", () =>
      Effect.gen(function* () {
        const workspaceUploads = yield* WorkspaceUploads.WorkspaceUploads;
        const cwd = yield* makeTempDir;

        const error = yield* workspaceUploads
          .uploadFile({
            cwd,
            fileName: "../escape.bin",
            dataUrl: toDataUrl(Uint8Array.from([1])),
          })
          .pipe(Effect.flip);

        expect(error).toBeInstanceOf(WorkspaceFileSystem.WorkspaceFilePathEscapeError);

        const nested = yield* workspaceUploads
          .uploadFile({
            cwd,
            fileName: "nested/file.bin",
            dataUrl: toDataUrl(Uint8Array.from([1])),
          })
          .pipe(Effect.flip);

        expect(nested).toBeInstanceOf(WorkspaceFileSystem.WorkspaceFilePathEscapeError);
      }),
    );

    it.effect("auto-renames instead of overwriting on collision", () =>
      Effect.gen(function* () {
        const workspaceUploads = yield* WorkspaceUploads.WorkspaceUploads;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        yield* writeExistingFile(cwd, "f.txt");
        yield* writeExistingFile(cwd, "f-1.txt");
        const bytes = Uint8Array.from([0x01, 0x02]);

        const result = yield* workspaceUploads.uploadFile({
          cwd,
          fileName: "f.txt",
          dataUrl: toDataUrl(bytes),
        });

        // REGRESSION: a collision must never overwrite the existing file and
        // must skip every taken candidate, not just the original name.
        expect(result.relativePath).toBe("f-2.txt");
        const original = yield* fileSystem.readFileString(path.join(cwd, "f.txt"));
        expect(original).toBe("existing\n");
        const written = yield* fileSystem.readFile(path.join(cwd, "f-2.txt"));
        expect(Buffer.from(written).equals(Buffer.from(bytes))).toBe(true);
      }),
    );

    it.effect("renames dotfiles by appending after the whole name", () =>
      Effect.gen(function* () {
        const workspaceUploads = yield* WorkspaceUploads.WorkspaceUploads;
        const cwd = yield* makeTempDir;
        yield* writeExistingFile(cwd, ".env");

        const result = yield* workspaceUploads.uploadFile({
          cwd,
          fileName: ".env",
          dataUrl: toDataUrl(Uint8Array.from([0x41])),
        });

        expect(result.relativePath).toBe(".env-1");
      }),
    );

    it.effect("rejects empty payloads", () =>
      Effect.gen(function* () {
        const workspaceUploads = yield* WorkspaceUploads.WorkspaceUploads;
        const cwd = yield* makeTempDir;

        const error = yield* workspaceUploads
          .uploadFile({
            cwd,
            fileName: "empty.bin",
            dataUrl: "data:application/octet-stream;base64,",
          })
          .pipe(Effect.flip);

        expect(error).toBeInstanceOf(WorkspaceFileSystem.WorkspaceFileSystemOperationError);
      }),
    );

    it.effect("rejects payloads that are not base64 data urls", () =>
      Effect.gen(function* () {
        const workspaceUploads = yield* WorkspaceUploads.WorkspaceUploads;
        const cwd = yield* makeTempDir;

        const error = yield* workspaceUploads
          .uploadFile({ cwd, fileName: "x.bin", dataUrl: "not-a-data-url" })
          .pipe(Effect.flip);

        expect(error).toBeInstanceOf(WorkspaceFileSystem.WorkspaceFileSystemOperationError);
      }),
    );

    it.effect("rejects payloads above the size cap", () =>
      Effect.gen(function* () {
        const workspaceUploads = yield* WorkspaceUploads.WorkspaceUploads;
        const cwd = yield* makeTempDir;
        const oversized = Buffer.alloc(PROJECT_UPLOAD_FILE_MAX_BYTES + 1, 0x61);

        const error = yield* workspaceUploads
          .uploadFile({ cwd, fileName: "big.bin", dataUrl: toDataUrl(oversized) })
          .pipe(Effect.flip);

        expect(error).toBeInstanceOf(WorkspaceFileSystem.WorkspaceFileSystemOperationError);
        expect(error.message).toContain("failed");
      }),
    );
  });
});
