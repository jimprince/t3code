import { AsyncResult } from "effect/reactivity";
import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId, PROJECT_UPLOAD_FILE_MAX_BYTES } from "@t3tools/contracts";
import { uploadWorkspaceFiles } from "./fileUploads";

const file = (name: string, size = 3) => ({ name, size }) as File;
describe("V2 workspace drops", () => {
  it("writes binary drops to the selected remote workspace and refreshes once after partial success", async () => {
    const written: { environment: string; cwd: string; name: string; bytes: string }[] = [];
    let directoryRevision = 0;
    let searchRevision = 0;
    const errors: string[] = [];
    const names = await uploadWorkspaceFiles({
      files: [file("a.zip"), file("unreadable"), file("a.zip")],
      containsDirectory: false,
      environmentId: EnvironmentId.make("remote-env"),
      cwd: "/remote/thread-worktree",
      readFile: async (f) => {
        if (f.name === "unreadable") throw new Error("Read denied");
        return "data:application/zip;base64,AP+A";
      },
      uploadFile: async ({ environmentId, input }) => {
        written.push({
          environment: environmentId,
          cwd: input.cwd,
          name: input.fileName,
          bytes: input.dataUrl,
        });
        return AsyncResult.success({
          relativePath: written.length === 1 ? "a.zip" : "a-1.zip",
          sizeBytes: 3,
        });
      },
      reportFailure: (e) => errors.push(e),
      refresh: () => {
        directoryRevision++;
        searchRevision++;
      },
    });
    expect(names).toEqual(["a.zip", "a-1.zip"]);
    expect(written).toEqual(
      names.map(() => ({
        environment: "remote-env",
        cwd: "/remote/thread-worktree",
        name: "a.zip",
        bytes: "data:application/zip;base64,AP+A",
      })),
    );
    expect(errors).toEqual(["Read denied"]);
    expect([directoryRevision, searchRevision]).toEqual([1, 1]);
  });
  it("rejects folders, empty and oversized files without reading or claiming an upload", async () => {
    const errors: string[] = [];
    const names = await uploadWorkspaceFiles({
      files: [file("empty", 0), file("big", PROJECT_UPLOAD_FILE_MAX_BYTES + 1)],
      containsDirectory: true,
      environmentId: EnvironmentId.make("env"),
      cwd: "/repo",
      readFile: () => {
        throw new Error("Invalid file was read");
      },
      uploadFile: () => {
        throw new Error("Invalid file was uploaded");
      },
      reportFailure: (error) => errors.push(error),
      refresh: () => {
        throw new Error("Rejected upload refreshed caches");
      },
    });
    expect(names).toEqual([]);
    expect(errors).toEqual([
      "Folders can't be uploaded. Drop individual files instead.",
      "'empty' is empty.",
      "'big' exceeds the 32 MiB upload limit.",
    ]);
  });
});
