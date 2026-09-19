import type * as THREE from "three";
import { expect, it, vi } from "vite-plus/test";

import {
  allowEmbeddedModelUrl,
  canOpenModelInOrcaSlicer,
  disposeModelObject,
  modelCanvasKey,
  modelViewportSize,
  refreshModelPreviewUrl,
  openModelInOrcaSlicer,
} from "./ModelViewer";

it("disposes model geometry, materials, and textures", () => {
  const geometry = { dispose: vi.fn() };
  const texture = { isTexture: true, dispose: vi.fn() };
  const close = vi.fn();
  Object.assign(texture, { source: { data: { close } } });
  const material = { map: texture, dispose: vi.fn() };
  const root = {
    traverse: (visit: (object: unknown) => void) => visit({ geometry, material }),
  } as unknown as THREE.Object3D;

  disposeModelObject(root);

  expect(geometry.dispose).toHaveBeenCalledOnce();
  expect(texture.dispose).toHaveBeenCalledOnce();
  expect(close).toHaveBeenCalledOnce();
  expect(material.dispose).toHaveBeenCalledOnce();
});

it("hands validated STL bytes to the local desktop bridge without exposing its URL", async () => {
  const handoff = vi.fn(async () => ({ opened: true }));
  vi.stubGlobal("window", {
    desktopBridge: { getClientPlatform: () => "darwin", openModelInOrcaSlicer: handoff },
  });
  const bytes = new Uint8Array(84);
  new DataView(bytes.buffer).setUint32(80, 0, true);
  const fetchModel = vi.fn(async () => new Response(bytes));

  expect(canOpenModelInOrcaSlicer("part.stl")).toBe(true);
  expect(canOpenModelInOrcaSlicer("part.3mf")).toBe(true);
  expect(canOpenModelInOrcaSlicer("part.glb")).toBe(false);
  await openModelInOrcaSlicer({
    url: "https://remote.example/signed-secret-model-url",
    name: "part.stl",
    fetchModel,
  });

  expect(handoff).toHaveBeenCalledWith({ name: "part.stl", bytes });
  expect(JSON.stringify(handoff.mock.calls)).not.toContain("signed-secret-model-url");
});

it("reuses already validated preview bytes without another signed URL request", async () => {
  const handoff = vi.fn(async () => ({ opened: true }));
  vi.stubGlobal("window", { desktopBridge: { openModelInOrcaSlicer: handoff } });
  const bytes = new Uint8Array(84);
  new DataView(bytes.buffer).setUint32(80, 0, true);
  const fetchModel = vi.fn();

  await openModelInOrcaSlicer({
    url: "https://remote.example/expired",
    name: "part.stl",
    bytes,
    fetchModel,
  });

  expect(fetchModel).not.toHaveBeenCalled();
  expect(handoff).toHaveBeenCalledWith({ name: "part.stl", bytes });
});

it("surfaces the desktop's missing-OrcaSlicer error", async () => {
  vi.stubGlobal("window", {
    desktopBridge: {
      openModelInOrcaSlicer: vi.fn(async () => ({
        opened: false,
        error: "OrcaSlicer could not be opened. Install OrcaSlicer in Applications and try again.",
      })),
    },
  });
  const bytes = new Uint8Array(84);
  new DataView(bytes.buffer).setUint32(80, 0, true);

  await expect(openModelInOrcaSlicer({ url: "unused", name: "part.stl", bytes })).rejects.toThrow(
    "Install OrcaSlicer in Applications",
  );
});

it("allows only embedded PNG and JPEG loader URLs", () => {
  expect(allowEmbeddedModelUrl("data:image/png;base64,AAAA")).toBe("data:image/png;base64,AAAA");
  expect(allowEmbeddedModelUrl("blob:https://app.test/embedded-image")).toBe(
    "blob:https://app.test/embedded-image",
  );
  expect(() => allowEmbeddedModelUrl("texture.png")).toThrow("external or relative");
  expect(() => allowEmbeddedModelUrl("https://example.test/texture.jpg")).toThrow(
    "external or relative",
  );
});

it("uses host dimensions and a new canvas identity for retries and visibility remounts", () => {
  expect(modelViewportSize({ clientWidth: 640, clientHeight: 360 })).toEqual({
    width: 640,
    height: 360,
  });
  expect(modelViewportSize({ clientWidth: 0, clientHeight: 0 })).toEqual({ width: 1, height: 1 });
  expect(modelCanvasKey("model.glb", 0, 1)).not.toBe(modelCanvasKey("model.glb", 1, 1));
  expect(modelCanvasKey("model.glb", 0, 1)).not.toBe(modelCanvasKey("model.glb", 0, 2));
});

it("turns URL refresh failures into finite retry errors and uses a refreshed URL", async () => {
  await expect(refreshModelPreviewUrl("old.glb", async () => "new.glb")).resolves.toBe("new.glb");
  await expect(refreshModelPreviewUrl("old.glb", async () => null)).rejects.toThrow("Reconnect");
  await expect(
    refreshModelPreviewUrl("old.glb", async () => {
      throw new Error("Session expired");
    }),
  ).rejects.toThrow("Session expired");
});
