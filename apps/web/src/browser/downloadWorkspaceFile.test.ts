import { AsyncResult } from "effect/unstable/reactivity";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  createWorkspaceFileDownloadUrl,
  startBrowserDownload,
  workspaceFileLinkPolicy,
} from "./downloadWorkspaceFile";

describe("remote workspace file downloads", () => {
  it.each([
    ["PrimaryConnectionTarget", "open"],
    ["BearerConnectionTarget", "download"],
    ["RelayConnectionTarget", "download"],
    ["SshConnectionTarget", "download"],
  ] as const)(
    "offers Download file for connected %s environments and defaults to %s",
    (targetTag, defaultAction) => {
      expect(workspaceFileLinkPolicy(true, targetTag)).toEqual({
        downloadAvailable: true,
        defaultAction,
      });
    },
  );

  it("does not offer downloads or default to them while disconnected", () => {
    expect(workspaceFileLinkPolicy(false, undefined)).toEqual({
      downloadAvailable: false,
      defaultAction: "open",
    });
  });

  it("requests an environment-scoped download capability and resolves it against that environment", async () => {
    const createAssetUrl = vi.fn(async () =>
      AsyncResult.success({
        relativeUrl: "/api/assets/signed/report.zip",
        expiresAt: Date.now() + 60_000,
      }),
    );

    const result = await createWorkspaceFileDownloadUrl({
      threadRef: {
        environmentId: EnvironmentId.make("remote-env"),
        threadId: ThreadId.make("thread-1"),
      },
      filePath: "/workspace/project/dist/report.zip",
      httpBaseUrl: "https://remote.example/base/",
      createAssetUrl,
    });

    expect(result).toMatchObject({
      _tag: "Success",
      value: "https://remote.example/api/assets/signed/report.zip",
    });
    expect(createAssetUrl).toHaveBeenCalledWith({
      environmentId: "remote-env",
      input: {
        resource: {
          _tag: "workspace-file-download",
          threadId: "thread-1",
          path: "/workspace/project/dist/report.zip",
        },
      },
    });
  });

  it("starts a browser-native download without reading the response into JavaScript", () => {
    const click = vi.fn();
    const remove = vi.fn();
    const append = vi.fn();
    vi.stubGlobal("document", {
      createElement: vi.fn(() => ({ href: "", rel: "", style: {}, click, remove })),
      body: { append },
    });
    startBrowserDownload("https://remote.example/api/assets/signed/report.zip");
    expect(click).toHaveBeenCalledOnce();
    expect(append).toHaveBeenCalledOnce();
    expect(remove).toHaveBeenCalledOnce();
  });
});
