import JSZip from "jszip";
import * as THREE from "three";
import { describe, expect, it } from "vite-plus/test";

import { applyThreeMfUnit, inspectThreeMfArchive, validateThreeMfBytes } from "./threeMfValidation";

const MODEL = `<?xml version="1.0" encoding="UTF-8"?>
<model unit="inch" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">
  <resources>
    <basematerials id="1"><base name="red" displaycolor="#ff0000ff" /></basematerials>
    <object id="2" type="model" pid="1" pindex="0"><mesh>
      <vertices><vertex x="0" y="0" z="0"/><vertex x="1" y="0" z="0"/><vertex x="0" y="1" z="0"/></vertices>
      <triangles><triangle v1="0" v2="1" v3="2"/></triangles>
    </mesh></object>
  </resources>
  <build><item objectid="2"/></build>
</model>`;

async function validThreeMf(): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file(
    "[Content_Types].xml",
    `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>`,
  );
  zip.file(
    "_rels/.rels",
    `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>`,
  );
  zip.file("3D/3dmodel.model", MODEL);
  return zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
}

function setCentralUncompressedSize(bytes: Uint8Array, size: number) {
  const copy = bytes.slice();
  const view = new DataView(copy.buffer);
  for (let offset = 0; offset <= copy.length - 46; offset += 1) {
    if (view.getUint32(offset, true) === 0x02014b50) {
      view.setUint32(offset + 24, size, true);
      return copy;
    }
  }
  throw new Error("central directory not found");
}

describe("3MF validation", () => {
  it("accepts a bounded package and applies its declared unit", async () => {
    const bytes = await validThreeMf();
    const validated = await validateThreeMfBytes(bytes);
    expect(validated.format).toBe("3mf");
    expect(validated.unitScale).toBe(25.4);

    const root = new THREE.Group();
    applyThreeMfUnit(root, validated.unitScale);
    expect(root.scale.toArray()).toEqual([25.4, 25.4, 25.4]);
  });

  it("rejects an oversized entry from ZIP metadata before inflation", async () => {
    const bytes = setCentralUncompressedSize(await validThreeMf(), 64 * 1024 * 1024 + 1);
    expect(() => inspectThreeMfArchive(bytes)).toThrow("64 MB uncompressed limit");
  });

  it("rejects zip bombs from cumulative metadata before inflation", async () => {
    const bytes = setCentralUncompressedSize(await validThreeMf(), 0xffffffff);
    expect(() => inspectThreeMfArchive(bytes)).toThrow(/64 MB|128 MB/);
  });

  it("rejects external relationships and package parts outside the model surface", async () => {
    const external = await validThreeMf();
    const zip = await JSZip.loadAsync(external);
    zip.file(
      "_rels/.rels",
      `<Relationships><Relationship Target="https://example.test/model" TargetMode="External"/></Relationships>`,
    );
    await expect(
      validateThreeMfBytes(await zip.generateAsync({ type: "uint8array" })),
    ).rejects.toThrow("external references");

    zip.file("Metadata/thumbnail.png", new Uint8Array([1, 2, 3]));
    const outside = await zip.generateAsync({ type: "uint8array" });
    expect(() => inspectThreeMfArchive(outside)).toThrow("outside the model and texture package");
  });
});
