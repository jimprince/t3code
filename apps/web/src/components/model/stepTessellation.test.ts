import * as THREE from "three";
import { expect, it } from "vite-plus/test";

import CUBE_STEP from "./fixtures/cube.step?raw";
import {
  assertStepMeshBounds,
  buildStepObject,
  validateStepHeader,
  type StepTessellationResult,
} from "./stepTessellation";

const triangle: StepTessellationResult = {
  meshes: [
    {
      name: "fixture",
      positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
      normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
      indices: new Uint32Array([0, 1, 2]),
      color: [1, 0.6, 0],
    },
  ],
  triangles: 1,
};

it("accepts a small STEP fixture and builds bounded colored geometry", () => {
  validateStepHeader(new TextEncoder().encode(CUBE_STEP));
  assertStepMeshBounds(triangle);
  const root = buildStepObject(THREE, triangle);
  const mesh = root.children[0] as THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>;
  expect(mesh.geometry.getAttribute("position").count).toBe(3);
  expect(mesh.material.color.getHex()).toBe(new THREE.Color(1, 0.6, 0).getHex());
});

it("rejects invalid STEP headers and tessellation output above the triangle cap", () => {
  expect(() => validateStepHeader(new TextEncoder().encode("not step"))).toThrow("valid STEP");
  const indices = new Uint32Array((2_000_000 + 1) * 3);
  expect(() =>
    assertStepMeshBounds({
      meshes: [
        {
          ...triangle.meshes[0]!,
          positions: new Float32Array([0, 0, 0]),
          normals: null,
          indices,
        },
      ],
      triangles: 2_000_001,
    }),
  ).toThrow("2 million triangle");
});
