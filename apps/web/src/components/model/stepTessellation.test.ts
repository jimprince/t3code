import initializeOcct from "occt-import-js";
import * as THREE from "three";
import { afterEach, expect, it, vi } from "vite-plus/test";

import CUBE_STEP from "./fixtures/cube.step?raw";
import {
  assertStepMeshBounds,
  buildStepObject,
  validateStepHeader,
  tessellateStep,
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

class TestWorker extends EventTarget {
  static last: TestWorker;
  terminate = vi.fn();
  postMessage = vi.fn();
  constructor() {
    super();
    TestWorker.last = this;
  }
}
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("terminates a cancelled STEP worker without accepting late output", async () => {
  vi.stubGlobal("Worker", TestWorker);
  vi.stubGlobal("window", { setTimeout: globalThis.setTimeout });
  const controller = new AbortController();
  const pending = tessellateStep(new TextEncoder().encode(CUBE_STEP), controller.signal);
  const rejection = expect(pending).rejects.toThrow("cancelled");
  controller.abort(new Error("cancelled"));
  await rejection;
  expect(TestWorker.last.terminate).toHaveBeenCalledOnce();
  expect(TestWorker.last.postMessage).toHaveBeenCalledOnce();
});

it("terminates STEP workers at the fixed deadline with fake time", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("Worker", TestWorker);
  vi.stubGlobal("window", { setTimeout: globalThis.setTimeout });
  const pending = tessellateStep(new TextEncoder().encode(CUBE_STEP), new AbortController().signal);
  const rejection = expect(pending).rejects.toThrow("20 second limit");
  await vi.advanceTimersByTimeAsync(20_000);
  await rejection;
  expect(TestWorker.last.terminate).toHaveBeenCalledOnce();
});

it("rejects nonfinite vertices and indices beyond the emitted vertex count", () => {
  expect(() =>
    assertStepMeshBounds({
      ...triangle,
      meshes: [{ ...triangle.meshes[0]!, positions: new Float32Array([NaN, 0, 0]) }],
    }),
  ).toThrow("invalid geometry");
  expect(() =>
    assertStepMeshBounds({
      ...triangle,
      meshes: [{ ...triangle.meshes[0]!, indices: new Uint32Array([0, 1, 3]) }],
    }),
  ).toThrow("indices");
});

it("tessellates the real cube and a two-part STEP assembly into bounded millimeter meshes", async () => {
  const importer = await initializeOcct();
  const body = CUBE_STEP.split("DATA;")[1]!.split("ENDSEC;")[0]!;
  // Independent entity IDs produce two solid parts without duplicating a fixture file.
  const secondPart = body.replace(/#(\d+)/g, (_, id: string) => `#${Number(id) + 10_000}`);
  const assembly = CUBE_STEP.replace(body, body + secondPart);
  for (const [source, parts] of [
    [CUBE_STEP, 1],
    [assembly, 2],
  ] as const) {
    const imported = importer.ReadStepFile(new TextEncoder().encode(source), {
      linearUnit: "millimeter",
      linearDeflectionType: "bounding_box_ratio",
      linearDeflection: 0.001,
      angularDeflection: 0.5,
    });
    expect(imported.success).toBe(true);
    expect(imported.meshes).toHaveLength(parts);
    const meshes = imported.meshes.map((mesh) => ({
      name: mesh.name,
      positions: new Float32Array(mesh.attributes.position.array),
      normals: mesh.attributes.normal ? new Float32Array(mesh.attributes.normal.array) : null,
      indices: new Uint32Array(mesh.index.array),
      color: mesh.color ?? null,
    }));
    const result = {
      meshes,
      triangles: meshes.reduce((sum, mesh) => sum + mesh.indices.length / 3, 0),
    };
    assertStepMeshBounds(result);
    expect(result.triangles).toBeGreaterThanOrEqual(12 * parts);
    const root = buildStepObject(THREE, result);
    const size = new THREE.Box3().setFromObject(root).getSize(new THREE.Vector3());
    expect(size.toArray()).toEqual([300, 300, 300]);
    root.children.forEach((child) => {
      const mesh = child as THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>;
      mesh.geometry.dispose();
      mesh.material.dispose();
    });
  }
});
