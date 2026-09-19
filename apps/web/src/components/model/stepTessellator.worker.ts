/// <reference lib="webworker" />

import { MODEL_PREVIEW_MAX_TRIANGLES } from "@t3tools/shared/filePreview";
import initializeOcct from "occt-import-js";
import occtWasmUrl from "occt-import-js/dist/occt-import-js.wasm?url";

import type { StepMeshData, StepTessellationResult } from "./stepTessellation";

const scope: DedicatedWorkerGlobalScope = self as DedicatedWorkerGlobalScope;
const occt = initializeOcct({
  locateFile: (path) => (path.endsWith(".wasm") ? occtWasmUrl : path),
});

scope.addEventListener(
  "message",
  async (event: MessageEvent<{ readonly id: number; readonly bytes: Uint8Array }>) => {
    const { id, bytes } = event.data;
    try {
      const importer = await occt;
      const imported = importer.ReadStepFile(bytes, {
        linearUnit: "millimeter",
        linearDeflectionType: "bounding_box_ratio",
        linearDeflection: 0.001,
        angularDeflection: 0.5,
      });
      if (!imported.success) throw new Error("The STEP file could not be tessellated.");
      let triangles = 0;
      const meshes: StepMeshData[] = imported.meshes.map((mesh) => {
        triangles += mesh.index.array.length / 3;
        if (!Number.isSafeInteger(triangles) || triangles > MODEL_PREVIEW_MAX_TRIANGLES) {
          throw new Error("Model geometry exceeds the 2 million triangle preview limit.");
        }
        return {
          name: mesh.name,
          positions: new Float32Array(mesh.attributes.position.array),
          normals: mesh.attributes.normal ? new Float32Array(mesh.attributes.normal.array) : null,
          indices: new Uint32Array(mesh.index.array),
          color: mesh.color ?? null,
        };
      });
      const result: StepTessellationResult = { meshes, triangles };
      const transfer = meshes.flatMap((mesh) => [
        mesh.positions.buffer,
        mesh.indices.buffer,
        ...(mesh.normals ? [mesh.normals.buffer] : []),
      ]);
      scope.postMessage({ id, ok: true, result }, transfer);
    } catch (cause) {
      scope.postMessage(
        {
          id,
          ok: false,
          error: cause instanceof Error ? cause.message : "The STEP file could not be tessellated.",
        },
        [],
      );
    }
  },
);
