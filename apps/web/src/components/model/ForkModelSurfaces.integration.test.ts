// @vitest-environment jsdom
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { act, createElement, Fragment } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vite-plus/test";

import {
  ChatMarkdownAssetModel,
  TimelineModelPreviews,
  WorkspaceModelPreview,
} from "./ModelAssetPreviews";

const asset = vi.hoisted(() => ({
  state: vi.fn(() => ({ _tag: "Failure" as const })),
  refresh: vi.fn(async () => "https://environment.test/renewed"),
}));
vi.mock("~/assets/assetUrls", () => ({
  useAssetUrlState: asset.state,
  useAssetUrlRefresh: () => asset.refresh,
}));
vi.mock("~/hooks/useWorkspaceMutationRefresh", () => ({ useWorkspaceMutationRefresh: () => {} }));

const environmentId = EnvironmentId.make("remote");
const threadRef = { environmentId, threadId: ThreadId.make("thread-1") };
afterEach(() => vi.clearAllMocks());

it.each(["part.glb", "part.stl", "part.3mf", "part.step", "part.stp"])(
  "V2 attachment %s retains a usable download when bounded preview is rejected",
  async (name) => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const node = document.createElement("div");
    const root = createRoot(node);
    const file = {
      type: "file" as const,
      id: "attachment-1",
      name,
      mimeType: "application/octet-stream",
      sizeBytes: 50 * 1024 * 1024 + 1,
    };
    const download = vi.fn();
    try {
      await act(() =>
        root.render(
          createElement(TimelineModelPreviews, {
            files: [file],
            environmentId,
            onDownload: download,
          }),
        ),
      );
      expect(node.textContent).toContain("larger than the 50 MB preview limit");
      expect(asset.state).toHaveBeenCalledWith(environmentId, null);
      const button = node.querySelector("button");
      expect(button?.getAttribute("aria-label")).toBe(`Download ${name}`);
      await act(() => button!.click());
      expect(download).toHaveBeenCalledWith(file);
    } finally {
      await act(() => root.unmount());
    }
  },
);

it("standalone links and workspace panels use exact workspace resources with retry/download fallback", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const node = document.createElement("div");
  const root = createRoot(node);
  try {
    await act(() =>
      root.render(
        createElement(
          Fragment,
          null,
          createElement(ChatMarkdownAssetModel, {
            threadRef,
            path: "/workspace/part.step",
            name: "part.step",
          }),
          createElement(WorkspaceModelPreview, {
            environmentId,
            threadRef,
            absolutePath: "/workspace/part.stl",
            name: "part.stl",
            workspaceMutationId: null,
          }),
        ),
      ),
    );
    expect(asset.state).toHaveBeenCalledWith(environmentId, {
      _tag: "workspace-file",
      threadId: threadRef.threadId,
      path: "/workspace/part.step",
    });
    expect(asset.state).toHaveBeenCalledWith(environmentId, {
      _tag: "workspace-file",
      threadId: threadRef.threadId,
      path: "/workspace/part.stl",
    });
    expect(node.textContent).toContain("Model unavailable. Retry");
    expect(node.textContent).toContain("Unable to preview this 3D model.");
    expect(node.textContent?.match(/Download file/g)).toHaveLength(2);
    await act(() => node.querySelector("button")!.click());
    expect(asset.refresh).toHaveBeenCalledOnce();
  } finally {
    await act(() => root.unmount());
  }
});
