import type * as THREE from "three";
import { expect, it, vi } from "vite-plus/test";

import {
  allowEmbeddedModelUrl,
  disposeModelObject,
  modelCanvasKey,
  modelViewportSize,
  refreshModelPreviewUrl,
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
