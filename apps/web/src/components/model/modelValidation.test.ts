import { MODEL_PREVIEW_MAX_BYTES } from "@t3tools/shared/filePreview";
import { describe, expect, it, vi } from "vite-plus/test";

import { readBoundedModelResponse, validateModelBytes } from "./modelValidation";

function glb(json: Record<string, unknown>, binary = new Uint8Array()) {
  const encoded = new TextEncoder().encode(JSON.stringify(json));
  const jsonLength = Math.ceil(encoded.length / 4) * 4;
  const binLength = Math.ceil(binary.length / 4) * 4;
  const total = 20 + jsonLength + (binary.length ? 8 + binLength : 0);
  const bytes = new Uint8Array(total);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 0x46546c67, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, total, true);
  view.setUint32(12, jsonLength, true);
  view.setUint32(16, 0x4e4f534a, true);
  bytes.fill(0x20, 20, 20 + jsonLength);
  bytes.set(encoded, 20);
  if (binary.length) {
    const offset = 20 + jsonLength;
    view.setUint32(offset, binLength, true);
    view.setUint32(offset + 4, 0x004e4942, true);
    bytes.set(binary, offset + 8);
  }
  return bytes;
}

function uncompressedTriangleGlb() {
  const binary = new Uint8Array(44);
  const view = new DataView(binary.buffer);
  for (const [index, value] of [0, 0, 0, 1, 0, 0, 0, 1, 0].entries()) {
    view.setFloat32(index * 4, value, true);
  }
  view.setUint16(36, 0, true);
  view.setUint16(38, 1, true);
  view.setUint16(40, 2, true);
  return glb(
    {
      asset: { version: "2.0" },
      buffers: [{ byteLength: 42 }],
      bufferViews: [
        { buffer: 0, byteOffset: 0, byteLength: 36 },
        { buffer: 0, byteOffset: 36, byteLength: 6 },
      ],
      accessors: [
        { bufferView: 0, componentType: 5126, count: 3, type: "VEC3" },
        { bufferView: 1, componentType: 5123, count: 3, type: "SCALAR" },
      ],
      meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }],
      nodes: [{ mesh: 0 }],
      scenes: [{ nodes: [0] }],
      scene: 0,
    },
    binary,
  );
}

describe("model byte validation", () => {
  it("accepts actual GLB v2 bytes and binary STL bytes", () => {
    expect(validateModelBytes(glb({ asset: { version: "2.0" } }), "scene.glb").format).toBe("glb");
    expect(validateModelBytes(uncompressedTriangleGlb(), "triangle.glb").format).toBe("glb");
    const stl = new Uint8Array(84 + 50);
    new DataView(stl.buffer).setUint32(80, 1, true);
    expect(validateModelBytes(stl, "part.stl").format).toBe("stl");
  });

  it("accepts structurally valid ASCII STL bytes", () => {
    const ascii = `solid named part
facet normal 0 0 1e0
outer loop
vertex 0 0 0
vertex +1.0 0 0
vertex 0 1 0
endloop
endfacet
endsolid named part`;
    expect(validateModelBytes(new TextEncoder().encode(ascii), "part.stl").format).toBe("stl");
  });

  it("rejects malformed ASCII facets and non-finite binary STL coordinates", () => {
    const malformed = `solid part
facet normal 0 0 1
outer loop
vertex 0 0 0
vertex 1 0 0
endloop
endfacet
endsolid part`;
    expect(() => validateModelBytes(new TextEncoder().encode(malformed), "part.stl")).toThrow(
      "ASCII STL geometry",
    );
    const binary = new Uint8Array(84 + 50);
    const view = new DataView(binary.buffer);
    view.setUint32(80, 1, true);
    view.setFloat32(84, Number.NaN, true);
    expect(() => validateModelBytes(binary, "part.stl")).toThrow("non-finite");
  });

  it("rejects extension spoofing, external resources, and unsupported compression", () => {
    expect(() => validateModelBytes(new TextEncoder().encode("not a model"), "scene.glb")).toThrow(
      "GLB",
    );
    expect(() =>
      validateModelBytes(
        glb({ asset: { version: "2.0" }, buffers: [{ uri: "mesh.bin" }] }),
        "scene.glb",
      ),
    ).toThrow("external or relative");
    expect(() =>
      validateModelBytes(
        glb({ asset: { version: "2.0" }, extensionsRequired: ["KHR_draco_mesh_compression"] }),
        "scene.glb",
      ),
    ).toThrow("compression extension");
    expect(() =>
      validateModelBytes(
        glb({ asset: { version: "2.0" }, extensionsRequired: ["UNKNOWN_required"] }),
        "scene.glb",
      ),
    ).toThrow("unsupported extension UNKNOWN_required");
    expect(() =>
      validateModelBytes(
        glb({
          asset: { version: "2.0" },
          extensions: { VENDOR_extension: { uri: "https://example.test/payload.bin" } },
        }),
        "scene.glb",
      ),
    ).toThrow("external or relative");
    expect(() =>
      validateModelBytes(
        glb({ asset: { version: "2.0" }, images: [{ uri: "data:image/svg+xml;base64,PHN2Zy8+" }] }),
        "scene.glb",
      ),
    ).toThrow("embedded PNG or JPEG");
  });

  it("rejects embedded textures over the decoded pixel budget", () => {
    const png = new Uint8Array(24);
    png.set([0x89, 0x50, 0x4e, 0x47], 0);
    png.set([0x49, 0x48, 0x44, 0x52], 12);
    const pngView = new DataView(png.buffer);
    pngView.setUint32(16, 8193);
    pngView.setUint32(20, 8192);
    expect(() =>
      validateModelBytes(
        glb(
          {
            asset: { version: "2.0" },
            buffers: [{ byteLength: png.byteLength }],
            bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: png.byteLength }],
            images: [{ bufferView: 0, mimeType: "image/png" }],
          },
          png,
        ),
        "scene.glb",
      ),
    ).toThrow("64 megapixel");
  });

  it("rejects geometry over the triangle budget before Three.js parsing", () => {
    const indices = new Uint8Array(2_000_003);
    expect(() =>
      validateModelBytes(
        glb(
          {
            asset: { version: "2.0" },
            buffers: [{ byteLength: indices.byteLength }],
            bufferViews: [{ buffer: 0, byteLength: indices.byteLength }],
            accessors: [
              { bufferView: 0, componentType: 5121, count: indices.byteLength, type: "SCALAR" },
            ],
            meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 0, mode: 5 }] }],
          },
          indices,
        ),
        "scene.glb",
      ),
    ).toThrow("2 million triangle");
  });

  it("rejects accessor allocation tricks, sparse data, cycles, and multi-parent nodes", () => {
    expect(() =>
      validateModelBytes(
        glb({
          asset: { version: "2.0" },
          accessors: [{ count: 1_000_000_000, componentType: 5126, type: "VEC3" }],
          meshes: [{ primitives: [{ attributes: { POSITION: 0 }, mode: 0 }] }],
        }),
        "points.glb",
      ),
    ).toThrow("allocation limit");
    expect(() =>
      validateModelBytes(
        glb({
          asset: { version: "2.0" },
          accessors: [{ sparse: { count: 1 } }],
        }),
        "sparse.glb",
      ),
    ).toThrow("Sparse GLB accessors");
    expect(() =>
      validateModelBytes(
        glb({
          asset: { version: "2.0" },
          nodes: [{ children: [1] }, { children: [0] }],
          scenes: [{ nodes: [0] }],
        }),
        "cycle.glb",
      ),
    ).toThrow("node cycle");
    expect(() =>
      validateModelBytes(
        glb({
          asset: { version: "2.0" },
          nodes: [{ children: [2] }, { children: [2] }, {}],
          scenes: [{ nodes: [0, 1] }],
        }),
        "instanced-node.glb",
      ),
    ).toThrow("node instancing");
  });

  it("bounds fetches from declared content length", async () => {
    const response = new Response(new Uint8Array([1]), {
      headers: { "content-length": String(MODEL_PREVIEW_MAX_BYTES + 1) },
    });
    await expect(readBoundedModelResponse(response, new AbortController().signal)).rejects.toThrow(
      "50 MB",
    );
  });

  it("cancels a streamed response as soon as its observed size overflows", async () => {
    const cancel = vi.fn(async () => undefined);
    const releaseLock = vi.fn();
    const response = {
      ok: true,
      headers: new Headers(),
      body: {
        getReader: () => ({
          read: vi.fn(async () => ({
            done: false,
            value: { byteLength: MODEL_PREVIEW_MAX_BYTES + 1 },
          })),
          cancel,
          releaseLock,
        }),
      },
    } as unknown as Response;
    await expect(readBoundedModelResponse(response, new AbortController().signal)).rejects.toThrow(
      "50 MB",
    );
    expect(cancel).toHaveBeenCalled();
    expect(releaseLock).toHaveBeenCalledOnce();
  });
});
