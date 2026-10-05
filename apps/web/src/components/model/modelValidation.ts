import {
  MODEL_PREVIEW_MAX_BYTES,
  MODEL_PREVIEW_MAX_TEXTURE_PIXELS,
  MODEL_PREVIEW_MAX_TRIANGLES,
} from "@t3tools/shared/filePreview";
import { readImageDimensions } from "@t3tools/shared/imageDimensions";

export type ValidatedModel =
  | { readonly format: "glb"; readonly bytes: ArrayBuffer }
  | { readonly format: "stl"; readonly bytes: ArrayBuffer };

type GltfAccessor = {
  readonly bufferView?: unknown;
  readonly byteOffset?: unknown;
  readonly componentType?: unknown;
  readonly count?: unknown;
  readonly sparse?: unknown;
  readonly type?: unknown;
};
type GltfBufferView = {
  readonly buffer?: unknown;
  readonly byteOffset?: unknown;
  readonly byteLength?: unknown;
  readonly byteStride?: unknown;
};
type GltfImage = {
  readonly uri?: unknown;
  readonly bufferView?: unknown;
  readonly mimeType?: unknown;
};

const COMPRESSION_EXTENSIONS = new Set([
  "KHR_draco_mesh_compression",
  "EXT_meshopt_compression",
  "KHR_texture_basisu",
]);
const SUPPORTED_REQUIRED_EXTENSIONS = new Set([
  "KHR_lights_punctual",
  "KHR_materials_clearcoat",
  "KHR_materials_emissive_strength",
  "KHR_materials_ior",
  "KHR_materials_iridescence",
  "KHR_materials_sheen",
  "KHR_materials_specular",
  "KHR_materials_transmission",
  "KHR_materials_unlit",
  "KHR_materials_variants",
  "KHR_materials_volume",
  "KHR_mesh_quantization",
  "KHR_texture_transform",
]);
const MAX_GLTF_ACCESSOR_ELEMENTS = MODEL_PREVIEW_MAX_TRIANGLES * 3;
const MAX_GLTF_DECODED_ACCESSOR_BYTES = 256 * 1024 * 1024;
const MAX_GLTF_GRAPH_ENTRIES = 100_000;

function fail(message: string): never {
  throw new Error(message);
}

function safeNonNegativeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function dataImageBytes(uri: string): Uint8Array | null {
  const match = /^data:(image\/(?:png|jpeg));base64,([A-Za-z0-9+/]*={0,2})$/i.exec(uri);
  if (!match?.[2]) return null;
  try {
    const binary = atob(match[2]);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
  } catch {
    return null;
  }
}

function rejectUnexpectedUris(json: Record<string, unknown>, images: ReadonlyArray<GltfImage>) {
  const imageObjects = new Set<unknown>(images);
  const pending: unknown[] = [json];
  while (pending.length > 0) {
    const value = pending.pop();
    if (!value || typeof value !== "object") continue;
    if (Array.isArray(value)) {
      pending.push(...value);
      continue;
    }
    for (const [key, child] of Object.entries(value)) {
      if (key === "uri" && !imageObjects.has(value)) {
        fail("GLB previews cannot load external or relative resources.");
      }
      pending.push(child);
    }
  }
}

function texturePixels(json: Record<string, unknown>, bin: Uint8Array): number {
  const images = Array.isArray(json.images) ? (json.images as GltfImage[]) : [];
  const bufferViews = Array.isArray(json.bufferViews) ? (json.bufferViews as GltfBufferView[]) : [];
  rejectUnexpectedUris(json, images);
  let pixels = 0;
  for (const image of images) {
    let bytes: Uint8Array | null = null;
    if (typeof image.uri === "string") {
      bytes = dataImageBytes(image.uri);
      if (!bytes) fail("GLB images must be embedded PNG or JPEG data.");
    } else {
      const index = safeNonNegativeInteger(image.bufferView);
      const bufferView = index === null ? undefined : bufferViews[index];
      const offset = safeNonNegativeInteger(bufferView?.byteOffset ?? 0);
      const length = safeNonNegativeInteger(bufferView?.byteLength);
      if (
        !bufferView ||
        bufferView.buffer !== 0 ||
        offset === null ||
        length === null ||
        offset + length > bin.byteLength ||
        (image.mimeType !== "image/png" && image.mimeType !== "image/jpeg")
      ) {
        fail("GLB textures must be embedded PNG or JPEG images.");
      }
      bytes = bin.subarray(offset, offset + length);
    }
    const dimensions = readImageDimensions(bytes.subarray(0, 256 * 1024));
    if (!dimensions) fail("An embedded GLB texture has an invalid PNG or JPEG header.");
    pixels += dimensions.width * dimensions.height;
    if (!Number.isSafeInteger(pixels) || pixels > MODEL_PREVIEW_MAX_TEXTURE_PIXELS) {
      fail("GLB textures exceed the 64 megapixel preview limit.");
    }
  }
  return pixels;
}

function accessorElementByteLength(componentType: number, type: string): number | null {
  const componentBytes = new Map([
    [5120, 1],
    [5121, 1],
    [5122, 2],
    [5123, 2],
    [5125, 4],
    [5126, 4],
  ]).get(componentType);
  if (!componentBytes) return null;
  const vectorComponents = new Map([
    ["SCALAR", 1],
    ["VEC2", 2],
    ["VEC3", 3],
    ["VEC4", 4],
  ]).get(type);
  if (vectorComponents) return vectorComponents * componentBytes;
  const matrixSize = new Map([
    ["MAT2", 2],
    ["MAT3", 3],
    ["MAT4", 4],
  ]).get(type);
  if (!matrixSize) return null;
  return matrixSize * Math.ceil((matrixSize * componentBytes) / 4) * 4;
}

function validateAccessors(json: Record<string, unknown>, bin: Uint8Array) {
  const buffers = Array.isArray(json.buffers) ? json.buffers : [];
  if (buffers.length > 1) fail("GLB previews support one embedded binary buffer.");
  const buffer = buffers[0];
  if (buffer !== undefined) {
    if (!buffer || typeof buffer !== "object") fail("The GLB binary buffer is invalid.");
    const byteLength = safeNonNegativeInteger((buffer as { byteLength?: unknown }).byteLength);
    if (byteLength === null || byteLength > bin.byteLength || bin.byteLength - byteLength > 3) {
      fail("The GLB binary buffer is invalid.");
    }
  }

  const bufferViews = Array.isArray(json.bufferViews) ? (json.bufferViews as GltfBufferView[]) : [];
  if (bufferViews.length > MAX_GLTF_GRAPH_ENTRIES) fail("The GLB has too many resources.");
  for (const bufferView of bufferViews) {
    const offset = safeNonNegativeInteger(bufferView?.byteOffset ?? 0);
    const length = safeNonNegativeInteger(bufferView?.byteLength);
    const stride =
      bufferView?.byteStride === undefined ? null : safeNonNegativeInteger(bufferView.byteStride);
    if (
      !bufferView ||
      bufferView.buffer !== 0 ||
      offset === null ||
      length === null ||
      offset + length > bin.byteLength ||
      (stride !== null && (stride < 4 || stride > 252 || stride % 4 !== 0))
    ) {
      fail("A GLB buffer view is invalid.");
    }
  }

  const accessors = Array.isArray(json.accessors) ? (json.accessors as GltfAccessor[]) : [];
  if (accessors.length > MAX_GLTF_GRAPH_ENTRIES) fail("The GLB has too many resources.");
  let decodedBytes = 0;
  for (const accessor of accessors) {
    if (accessor?.sparse !== undefined) {
      fail("Sparse GLB accessors are not supported in previews.");
    }
    const bufferViewIndex = safeNonNegativeInteger(accessor?.bufferView);
    const bufferView = bufferViewIndex === null ? undefined : bufferViews[bufferViewIndex];
    const count = safeNonNegativeInteger(accessor?.count);
    const componentType = safeNonNegativeInteger(accessor?.componentType);
    const type = typeof accessor?.type === "string" ? accessor.type : "";
    const elementBytes =
      componentType === null ? null : accessorElementByteLength(componentType, type);
    const byteOffset = safeNonNegativeInteger(accessor?.byteOffset ?? 0);
    if (
      !bufferView ||
      count === null ||
      count > MAX_GLTF_ACCESSOR_ELEMENTS ||
      elementBytes === null ||
      byteOffset === null
    ) {
      fail("A GLB accessor is invalid or exceeds the preview allocation limit.");
    }
    const stride = safeNonNegativeInteger(bufferView.byteStride) ?? elementBytes;
    if (stride < elementBytes) fail("A GLB accessor stride is invalid.");
    const requiredBytes =
      count === 0 ? byteOffset : byteOffset + stride * (count - 1) + elementBytes;
    if (!Number.isSafeInteger(requiredBytes) || requiredBytes > Number(bufferView.byteLength)) {
      fail("A GLB accessor points outside its embedded buffer view.");
    }
    decodedBytes += count * elementBytes;
    if (!Number.isSafeInteger(decodedBytes) || decodedBytes > MAX_GLTF_DECODED_ACCESSOR_BYTES) {
      fail("GLB accessors exceed the preview allocation limit.");
    }
  }
}

function primitiveTriangleCount(
  primitiveValue: unknown,
  accessors: ReadonlyArray<GltfAccessor>,
): number {
  if (!primitiveValue || typeof primitiveValue !== "object") {
    fail("A GLB mesh primitive is invalid.");
  }
  const primitive = primitiveValue as {
    indices?: unknown;
    mode?: unknown;
    attributes?: Record<string, unknown>;
  };
  const mode = primitive.mode ?? 4;
  if (!Number.isInteger(mode) || (mode as number) < 0 || (mode as number) > 6) {
    fail("A GLB mesh primitive mode is invalid.");
  }
  const attributes = primitive.attributes;
  if (!attributes || typeof attributes !== "object") fail("A GLB mesh has no vertex attributes.");
  for (const accessorValue of Object.values(attributes)) {
    const accessorIndex = safeNonNegativeInteger(accessorValue);
    if (accessorIndex === null || !accessors[accessorIndex]) {
      fail("A GLB mesh references an invalid accessor.");
    }
  }
  const accessorIndex = safeNonNegativeInteger(primitive.indices ?? attributes.POSITION);
  const count =
    accessorIndex === null ? null : safeNonNegativeInteger(accessors[accessorIndex]?.count);
  if (count === null) fail("GLB mesh geometry is missing a valid vertex count.");
  if (mode === 4) return Math.floor(count / 3);
  return mode === 5 || mode === 6 ? Math.max(0, count - 2) : 0;
}

function triangleCount(json: Record<string, unknown>): number {
  const accessors = Array.isArray(json.accessors) ? (json.accessors as GltfAccessor[]) : [];
  const meshes = Array.isArray(json.meshes) ? json.meshes : [];
  const nodes = Array.isArray(json.nodes) ? json.nodes : [];
  const scenes = Array.isArray(json.scenes) ? json.scenes : [];
  if (
    meshes.length > MAX_GLTF_GRAPH_ENTRIES ||
    nodes.length > MAX_GLTF_GRAPH_ENTRIES ||
    scenes.length > MAX_GLTF_GRAPH_ENTRIES
  ) {
    fail("The GLB scene graph is too large.");
  }
  const meshTriangles = meshes.map((mesh) => {
    if (!mesh || typeof mesh !== "object") fail("A GLB mesh is invalid.");
    const primitives = (mesh as { primitives?: unknown }).primitives;
    if (!Array.isArray(primitives) || primitives.length === 0)
      fail("A GLB mesh has no primitives.");
    return primitives.reduce<number>(
      (total, primitive) => total + primitiveTriangleCount(primitive, accessors),
      0,
    );
  });

  const childrenByNode = nodes.map((node) => {
    if (!node || typeof node !== "object") fail("A GLB node is invalid.");
    const children = (node as { children?: unknown }).children;
    if (children === undefined) return [];
    if (!Array.isArray(children)) fail("A GLB node has invalid children.");
    return children.map((child) => {
      const index = safeNonNegativeInteger(child);
      if (index === null || !nodes[index]) fail("A GLB node references an invalid child.");
      return index;
    });
  });

  const colors = new Uint8Array(nodes.length);
  for (let start = 0; start < nodes.length; start += 1) {
    if (colors[start] !== 0) continue;
    const stack: Array<{ index: number; nextChild: number }> = [{ index: start, nextChild: 0 }];
    colors[start] = 1;
    while (stack.length > 0) {
      const frame = stack.at(-1)!;
      const child = childrenByNode[frame.index]![frame.nextChild++];
      if (child === undefined) {
        colors[frame.index] = 2;
        stack.pop();
      } else if (colors[child] === 1) {
        fail("The GLB scene graph contains a node cycle.");
      } else if (colors[child] === 0) {
        colors[child] = 1;
        stack.push({ index: child, nextChild: 0 });
      }
    }
  }

  if (scenes.length === 0) {
    const triangles = meshTriangles.reduce((total, count) => total + count, 0);
    if (!Number.isSafeInteger(triangles) || triangles > MODEL_PREVIEW_MAX_TRIANGLES) {
      fail("Model geometry exceeds the 2 million triangle preview limit.");
    }
    return triangles;
  }
  const sceneIndex = safeNonNegativeInteger(json.scene ?? 0);
  const scene = sceneIndex === null ? undefined : scenes[sceneIndex];
  if (!scene || typeof scene !== "object") fail("The GLB default scene is invalid.");
  const roots = (scene as { nodes?: unknown }).nodes;
  if (!Array.isArray(roots)) fail("The GLB default scene has invalid root nodes.");
  const parentCounts = new Uint8Array(nodes.length);
  const pending = roots.map((root) => {
    const index = safeNonNegativeInteger(root);
    if (index === null || !nodes[index]) fail("The GLB scene references an invalid node.");
    parentCounts[index] = (parentCounts[index] ?? 0) + 1;
    return index;
  });
  for (const children of childrenByNode) {
    for (const child of children) parentCounts[child] = (parentCounts[child] ?? 0) + 1;
  }
  if (parentCounts.some((count) => count > 1)) {
    fail("GLB node instancing is not supported in previews; instance meshes with separate nodes.");
  }
  let triangles = 0;
  let visits = 0;
  while (pending.length > 0) {
    const nodeIndex = pending.pop()!;
    visits += 1;
    if (visits > MAX_GLTF_GRAPH_ENTRIES) fail("The GLB scene graph is too large.");
    const node = nodes[nodeIndex] as { mesh?: unknown };
    if (node.mesh !== undefined) {
      const meshIndex = safeNonNegativeInteger(node.mesh);
      if (meshIndex === null || meshTriangles[meshIndex] === undefined) {
        fail("A GLB node references an invalid mesh.");
      }
      triangles += meshTriangles[meshIndex];
      if (!Number.isSafeInteger(triangles) || triangles > MODEL_PREVIEW_MAX_TRIANGLES) {
        fail("Model geometry exceeds the 2 million triangle preview limit.");
      }
    }
    pending.push(...childrenByNode[nodeIndex]!);
  }
  return triangles;
}

function validateGlb(bytes: Uint8Array): ValidatedModel {
  if (bytes.byteLength < 20) fail("This is not a valid GLB file.");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== 0x46546c67 || view.getUint32(4, true) !== 2) {
    fail("Only GLB version 2 files can be previewed.");
  }
  if (view.getUint32(8, true) !== bytes.byteLength) fail("The GLB byte length is invalid.");
  const jsonLength = view.getUint32(12, true);
  if (view.getUint32(16, true) !== 0x4e4f534a || 20 + jsonLength > bytes.byteLength) {
    fail("The GLB JSON chunk is invalid.");
  }
  let json: Record<string, unknown>;
  try {
    json = JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + jsonLength))) as Record<
      string,
      unknown
    >;
  } catch {
    return fail("The GLB JSON chunk is invalid.");
  }
  const required = Array.isArray(json.extensionsRequired) ? json.extensionsRequired : [];
  const used = Array.isArray(json.extensionsUsed) ? json.extensionsUsed : [];
  if ([...required, ...used].some((entry) => typeof entry !== "string")) {
    fail("The GLB extension declarations are invalid.");
  }
  if ([...required, ...used].some((entry) => COMPRESSION_EXTENSIONS.has(entry as string))) {
    fail("This GLB uses a compression extension that is not supported in previews.");
  }
  if (used.includes("EXT_mesh_gpu_instancing")) {
    fail("GPU-instanced GLB scenes are not supported in previews.");
  }
  const unsupportedRequired = required.find(
    (entry) => !SUPPORTED_REQUIRED_EXTENSIONS.has(entry as string),
  );
  if (unsupportedRequired) {
    fail(`This GLB requires unsupported extension ${String(unsupportedRequired)}.`);
  }
  rejectUnexpectedUris(json, Array.isArray(json.images) ? (json.images as GltfImage[]) : []);

  let bin: Uint8Array<ArrayBufferLike> = new Uint8Array();
  const binHeader = 20 + jsonLength;
  if (binHeader < bytes.byteLength) {
    if (binHeader + 8 > bytes.byteLength || view.getUint32(binHeader + 4, true) !== 0x004e4942) {
      fail("The GLB binary chunk is invalid.");
    }
    const binLength = view.getUint32(binHeader, true);
    if (binHeader + 8 + binLength !== bytes.byteLength) fail("The GLB binary chunk is invalid.");
    bin = bytes.subarray(binHeader + 8, binHeader + 8 + binLength);
  }
  validateAccessors(json, bin);
  triangleCount(json);
  texturePixels(json, bin);
  return { format: "glb", bytes: bytes.slice().buffer };
}

const ASCII_STL_NUMBER = "[-+]?(?:\\d+(?:\\.\\d*)?|\\.\\d+)(?:[eE][-+]?\\d+)?";
const ASCII_STL_FACET = new RegExp(
  `\\s*facet\\s+normal\\s+(${ASCII_STL_NUMBER})\\s+(${ASCII_STL_NUMBER})\\s+(${ASCII_STL_NUMBER})` +
    `\\s+outer\\s+loop` +
    `\\s+vertex\\s+(${ASCII_STL_NUMBER})\\s+(${ASCII_STL_NUMBER})\\s+(${ASCII_STL_NUMBER})` +
    `\\s+vertex\\s+(${ASCII_STL_NUMBER})\\s+(${ASCII_STL_NUMBER})\\s+(${ASCII_STL_NUMBER})` +
    `\\s+vertex\\s+(${ASCII_STL_NUMBER})\\s+(${ASCII_STL_NUMBER})\\s+(${ASCII_STL_NUMBER})` +
    "\\s+endloop\\s+endfacet",
  "iy",
);

function validateStl(bytes: Uint8Array): ValidatedModel {
  if (bytes.byteLength >= 84) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const triangles = view.getUint32(80, true);
    if (84 + triangles * 50 === bytes.byteLength) {
      if (triangles > MODEL_PREVIEW_MAX_TRIANGLES) {
        fail("Model geometry exceeds the 2 million triangle preview limit.");
      }
      for (let triangle = 0; triangle < triangles; triangle += 1) {
        const offset = 84 + triangle * 50;
        for (let coordinate = 0; coordinate < 12; coordinate += 1) {
          if (!Number.isFinite(view.getFloat32(offset + coordinate * 4, true))) {
            fail("The binary STL geometry contains non-finite coordinates.");
          }
        }
      }
      return { format: "stl", bytes: bytes.slice().buffer };
    }
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return fail("This is not a valid binary or ASCII STL file.");
  }
  const header = /^\s*solid(?:[^\r\n]*)?(?:\r?\n|\r)/i.exec(text);
  if (!header) fail("This is not a valid binary or ASCII STL file.");
  let offset = header[0].length;
  let triangles = 0;
  while (true) {
    ASCII_STL_FACET.lastIndex = offset;
    const facet = ASCII_STL_FACET.exec(text);
    if (!facet) break;
    if (facet.slice(1).some((value) => !Number.isFinite(Number(value)))) {
      fail("The ASCII STL geometry contains non-finite coordinates.");
    }
    triangles += 1;
    if (triangles > MODEL_PREVIEW_MAX_TRIANGLES) {
      fail("Model geometry exceeds the 2 million triangle preview limit.");
    }
    offset = ASCII_STL_FACET.lastIndex;
  }
  if (triangles === 0 || !/^\s*endsolid(?:[^\r\n]*)?\s*$/i.test(text.slice(offset))) {
    fail("The ASCII STL geometry is invalid.");
  }
  return { format: "stl", bytes: bytes.slice().buffer };
}

export function validateModelBytes(bytes: Uint8Array, name: string): ValidatedModel {
  if (bytes.byteLength === 0) fail("The model file is empty.");
  if (bytes.byteLength > MODEL_PREVIEW_MAX_BYTES) fail("Model previews are limited to 50 MB.");
  if (/\.glb$/i.test(name)) return validateGlb(bytes);
  if (/\.stl$/i.test(name)) return validateStl(bytes);
  return fail("Only GLB and STL files can be previewed.");
}

export async function readBoundedModelResponse(
  response: Response,
  signal: AbortSignal,
): Promise<Uint8Array> {
  if (!response.ok) fail("The model could not be loaded. Try again.");
  const contentLength = response.headers.get("content-length");
  const declared = contentLength === null ? null : Number(contentLength);
  if (declared !== null && (!Number.isFinite(declared) || declared < 0)) {
    fail("The model response has an invalid size.");
  }
  if (declared !== null && declared > MODEL_PREVIEW_MAX_BYTES) {
    fail("Model previews are limited to 50 MB.");
  }
  if (!response.body) {
    if (declared === null) fail("The model response size could not be verified.");
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > MODEL_PREVIEW_MAX_BYTES) fail("Model previews are limited to 50 MB.");
    return bytes;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      if (signal.aborted) throw signal.reason;
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MODEL_PREVIEW_MAX_BYTES) {
        await reader.cancel("Model preview exceeded its byte limit.").catch(() => undefined);
        fail("Model previews are limited to 50 MB.");
      }
      chunks.push(value);
    }
  } catch (cause) {
    await reader.cancel(cause).catch(() => undefined);
    throw cause;
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}
