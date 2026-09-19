import {
  MODEL_PREVIEW_MAX_TEXTURE_PIXELS,
  MODEL_PREVIEW_MAX_TRIANGLES,
} from "@t3tools/shared/filePreview";
import { readImageDimensions } from "@t3tools/shared/imageDimensions";
import JSZip from "jszip";
import type * as THREE from "three";

const MAX_ARCHIVE_ENTRIES = 256;
const MAX_ARCHIVE_ENTRY_BYTES = 64 * 1024 * 1024;
const MAX_ARCHIVE_TOTAL_BYTES = 128 * 1024 * 1024;
const ZIP_EOCD_SIGNATURE = 0x06054b50;
const ZIP_CENTRAL_SIGNATURE = 0x02014b50;
const ARCHIVE_EXTENSION = /\.(?:3mf|7z|bz2|gz|rar|tar|tgz|xz|zip)$/i;
const MODEL_UNIT_IN_MILLIMETERS: Readonly<Record<string, number>> = {
  micron: 0.001,
  millimeter: 1,
  centimeter: 10,
  inch: 25.4,
  foot: 304.8,
  meter: 1000,
};

export type ThreeMfArchiveInfo = {
  readonly entries: number;
  readonly totalUncompressedBytes: number;
};

export type ValidatedThreeMf = {
  readonly format: "3mf";
  readonly bytes: ArrayBuffer;
  readonly unitScale: number;
};

function fail(message: string): never {
  throw new Error(message);
}

function normalizedPartName(rawName: string): string {
  if (
    rawName.length === 0 ||
    rawName.includes("\\") ||
    rawName.includes("\0") ||
    rawName.startsWith("/") ||
    rawName.split("/").some((segment) => segment === ".." || segment === ".")
  ) {
    return fail("The 3MF archive contains an unsafe part path.");
  }
  return rawName.replace(/^\.\//, "");
}

function isAllowedPart(name: string): boolean {
  return (
    name === "[Content_Types].xml" ||
    name === "_rels/.rels" ||
    /^3D\/(?:[^/]+\/)*[^/]+\.model$/i.test(name) ||
    /^3D\/(?:[^/]+\/)*_rels\/[^/]+\.rels$/i.test(name) ||
    /^3D\/Textures?\/(?:[^/]+\/)*[^/]+$/i.test(name)
  );
}

function isAllowedDirectory(name: string): boolean {
  return name === "_rels/" || /^3D\/(?:Textures?\/|(?:[^/]+\/)*_rels\/)?$/i.test(name);
}

/** Reads only ZIP metadata. No entry is inflated until every archive bound passes. */
export function inspectThreeMfArchive(bytes: Uint8Array): ThreeMfArchiveInfo {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const searchStart = Math.max(0, bytes.byteLength - 65_557);
  let eocd = -1;
  for (let offset = bytes.byteLength - 22; offset >= searchStart; offset -= 1) {
    if (view.getUint32(offset, true) === ZIP_EOCD_SIGNATURE) {
      eocd = offset;
      break;
    }
  }
  if (eocd < 0) return fail("This is not a valid 3MF archive.");
  const disk = view.getUint16(eocd + 4, true);
  const centralDisk = view.getUint16(eocd + 6, true);
  const entriesOnDisk = view.getUint16(eocd + 8, true);
  const entries = view.getUint16(eocd + 10, true);
  const centralSize = view.getUint32(eocd + 12, true);
  const centralOffset = view.getUint32(eocd + 16, true);
  if (
    disk !== 0 ||
    centralDisk !== 0 ||
    entries !== entriesOnDisk ||
    entries > MAX_ARCHIVE_ENTRIES
  ) {
    return fail("The 3MF archive has too many entries or uses unsupported ZIP features.");
  }
  if (centralOffset + centralSize > eocd || centralOffset + centralSize > bytes.byteLength) {
    return fail("The 3MF ZIP directory is invalid.");
  }

  const decoder = new TextDecoder("utf-8", { fatal: true });
  let offset = centralOffset;
  let totalUncompressedBytes = 0;
  const names = new Set<string>();
  for (let index = 0; index < entries; index += 1) {
    if (offset + 46 > bytes.byteLength || view.getUint32(offset, true) !== ZIP_CENTRAL_SIGNATURE) {
      return fail("The 3MF ZIP directory is invalid.");
    }
    const flags = view.getUint16(offset + 8, true);
    const compression = view.getUint16(offset + 10, true);
    const compressedBytes = view.getUint32(offset + 20, true);
    const uncompressedBytes = view.getUint32(offset + 24, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const end = offset + 46 + nameLength + extraLength + commentLength;
    if (end > bytes.byteLength || (flags & 1) !== 0 || (compression !== 0 && compression !== 8)) {
      return fail("The 3MF archive uses unsupported ZIP features.");
    }
    if (compressedBytes > bytes.byteLength || uncompressedBytes > MAX_ARCHIVE_ENTRY_BYTES) {
      return fail("A 3MF archive entry exceeds the 64 MB uncompressed limit.");
    }
    totalUncompressedBytes += uncompressedBytes;
    if (
      !Number.isSafeInteger(totalUncompressedBytes) ||
      totalUncompressedBytes > MAX_ARCHIVE_TOTAL_BYTES
    ) {
      return fail("The 3MF archive exceeds the 128 MB total uncompressed limit.");
    }
    let name: string;
    try {
      name = normalizedPartName(
        decoder.decode(bytes.subarray(offset + 46, offset + 46 + nameLength)),
      );
    } catch {
      return fail("The 3MF archive contains an invalid part name.");
    }
    const isDirectory = name.endsWith("/");
    if (
      (isDirectory && (uncompressedBytes !== 0 || !isAllowedDirectory(name))) ||
      (!isDirectory && (!isAllowedPart(name) || ARCHIVE_EXTENSION.test(name)))
    ) {
      return fail("The 3MF archive contains a part outside the model and texture package.");
    }
    const foldedName = name.toLowerCase();
    if (names.has(foldedName)) return fail("The 3MF archive contains duplicate part names.");
    names.add(foldedName);
    offset = end;
  }
  if (offset !== centralOffset + centralSize) return fail("The 3MF ZIP directory is invalid.");
  if (!names.has("[content_types].xml") || !names.has("_rels/.rels")) {
    return fail("The 3MF package is missing required metadata.");
  }
  if (![...names].some((name) => name.endsWith(".model"))) {
    return fail("The 3MF package contains no model part.");
  }
  return { entries, totalUncompressedBytes };
}

function assertWellFormedXml(text: string, partName: string) {
  if (typeof DOMParser === "undefined") return;
  const document = new DOMParser().parseFromString(text, "application/xml");
  if (document.querySelector("parsererror")) fail(`The 3MF ${partName} XML is invalid.`);
}

function xmlAttribute(source: string, name: string): string | null {
  const match = new RegExp(`\\b${name}\\s*=\\s*(["'])(.*?)\\1`, "i").exec(source);
  return match?.[2] ?? null;
}

function assertInternalRelationships(text: string) {
  for (const relationship of text.matchAll(/<Relationship\b[^>]*>/gi)) {
    const target = xmlAttribute(relationship[0], "Target")?.trim() ?? "";
    if (
      xmlAttribute(relationship[0], "TargetMode")?.toLowerCase() === "external" ||
      /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(target)
    )
      fail("3MF previews cannot load external references.");
  }
}

export async function validateThreeMfBytes(bytes: Uint8Array): Promise<ValidatedThreeMf> {
  inspectThreeMfArchive(bytes);
  const archive = await JSZip.loadAsync(bytes, {
    checkCRC32: true,
    createFolders: false,
  });
  let unit: string | null = null;
  let triangles = 0;
  let texturePixels = 0;
  for (const [rawName, file] of Object.entries(archive.files)) {
    const name = normalizedPartName(rawName);
    if (file.dir) {
      if (!isAllowedDirectory(name)) fail("The 3MF archive contains an invalid part.");
      continue;
    }
    if (!isAllowedPart(name)) fail("The 3MF archive contains an invalid part.");
    const entry = await file.async("uint8array");
    if (
      entry.length >= 4 &&
      new DataView(entry.buffer, entry.byteOffset, 4).getUint32(0, true) === 0x04034b50
    ) {
      fail("Nested archives are not allowed in 3MF previews.");
    }
    if (/\.(?:model|rels)$/i.test(name) || name === "[Content_Types].xml") {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(entry);
      assertWellFormedXml(text, name);
      if (/\.rels$/i.test(name)) assertInternalRelationships(text);
      if (/\.model$/i.test(name)) {
        const modelTag = /<model\b[^>]*>/i.exec(text)?.[0];
        if (!modelTag) fail("A 3MF model part is invalid.");
        const modelUnit = (xmlAttribute(modelTag, "unit") || "millimeter").toLowerCase();
        if (MODEL_UNIT_IN_MILLIMETERS[modelUnit] === undefined) {
          fail(`The 3MF model uses unsupported unit ${modelUnit}.`);
        }
        if (unit !== null && unit !== modelUnit) fail("3MF model parts must use the same unit.");
        unit = modelUnit;
        triangles += [...text.matchAll(/<triangle\b/gi)].length;
        if (triangles > MODEL_PREVIEW_MAX_TRIANGLES) {
          fail("Model geometry exceeds the 2 million triangle preview limit.");
        }
        for (const texture of text.matchAll(/<texture2d\b[^>]*>/gi)) {
          const path = xmlAttribute(texture[0], "path") ?? "";
          if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(path)) {
            fail("3MF previews cannot load external references.");
          }
        }
      }
    } else if (/^3D\/Textures?\//i.test(name)) {
      const dimensions = readImageDimensions(entry.subarray(0, 256 * 1024));
      if (!dimensions) fail("3MF textures must be valid PNG or JPEG images.");
      texturePixels += dimensions.width * dimensions.height;
      if (
        !Number.isSafeInteger(texturePixels) ||
        texturePixels > MODEL_PREVIEW_MAX_TEXTURE_PIXELS
      ) {
        fail("3MF textures exceed the 64 megapixel preview limit.");
      }
    }
  }
  if (unit === null) fail("The 3MF package contains no valid model part.");
  return {
    format: "3mf",
    bytes: bytes.slice().buffer,
    unitScale: MODEL_UNIT_IN_MILLIMETERS[unit]!,
  };
}

export function applyThreeMfUnit(root: THREE.Object3D, unitScale: number) {
  root.scale.multiplyScalar(unitScale);
  root.updateMatrixWorld(true);
}

export function assertRenderedTriangleLimit(root: THREE.Object3D) {
  let triangles = 0;
  root.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (!mesh.geometry) return;
    const count = mesh.geometry.index?.count ?? mesh.geometry.getAttribute("position")?.count ?? 0;
    triangles += Math.floor(count / 3);
    if (!Number.isSafeInteger(triangles) || triangles > MODEL_PREVIEW_MAX_TRIANGLES) {
      fail("Model geometry exceeds the 2 million triangle preview limit.");
    }
  });
}
