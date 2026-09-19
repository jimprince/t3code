import { MODEL_PREVIEW_MAX_TRIANGLES } from "@t3tools/shared/filePreview";
import type * as THREE from "three";

export type StepMeshData = {
  readonly name: string;
  readonly positions: Float32Array;
  readonly normals: Float32Array | null;
  readonly indices: Uint32Array;
  readonly color: readonly [number, number, number] | null;
};

export type StepTessellationResult = {
  readonly meshes: readonly StepMeshData[];
  readonly triangles: number;
};

type WorkerResponse =
  | { readonly id: number; readonly ok: true; readonly result: StepTessellationResult }
  | { readonly id: number; readonly ok: false; readonly error: string };

const STEP_TESSELLATION_TIMEOUT_MS = 20_000;

export function validateStepHeader(bytes: Uint8Array) {
  const header = new TextDecoder("ascii").decode(bytes.subarray(0, Math.min(bytes.length, 4096)));
  if (!/^\s*ISO-10303-21\s*;/i.test(header) || !/\bHEADER\s*;/i.test(header)) {
    throw new Error("This is not a valid STEP file.");
  }
}

export function assertStepMeshBounds(result: StepTessellationResult) {
  let triangles = 0;
  for (const mesh of result.meshes) {
    if (
      mesh.positions.length % 3 !== 0 ||
      mesh.indices.length % 3 !== 0 ||
      (mesh.normals !== null && mesh.normals.length !== mesh.positions.length) ||
      mesh.positions.some((value) => !Number.isFinite(value)) ||
      mesh.normals?.some((value) => !Number.isFinite(value)) === true
    ) {
      throw new Error("The STEP tessellator returned invalid geometry.");
    }
    const vertices = mesh.positions.length / 3;
    if (mesh.indices.some((index) => index >= vertices)) {
      throw new Error("The STEP tessellator returned invalid geometry indices.");
    }
    triangles += mesh.indices.length / 3;
    if (!Number.isSafeInteger(triangles) || triangles > MODEL_PREVIEW_MAX_TRIANGLES) {
      throw new Error("Model geometry exceeds the 2 million triangle preview limit.");
    }
  }
  if (triangles === 0 || triangles !== result.triangles) {
    throw new Error("The STEP model contains no renderable geometry.");
  }
}

export async function tessellateStep(
  bytes: Uint8Array,
  signal: AbortSignal,
): Promise<StepTessellationResult> {
  validateStepHeader(bytes);
  if (signal.aborted) throw signal.reason;
  const worker = new Worker(new URL("./stepTessellator.worker.ts", import.meta.url), {
    type: "module",
    name: "t3-step-tessellator",
  });
  const id = crypto.getRandomValues(new Uint32Array(1))[0]!;
  return new Promise<StepTessellationResult>((resolve, reject) => {
    let settled = false;
    const finish = (action: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal.removeEventListener("abort", abort);
      worker.terminate();
      action();
    };
    const abort = () => finish(() => reject(signal.reason));
    const timeout = window.setTimeout(
      () => finish(() => reject(new Error("STEP tessellation exceeded the 20 second limit."))),
      STEP_TESSELLATION_TIMEOUT_MS,
    );
    signal.addEventListener("abort", abort, { once: true });
    worker.addEventListener("error", () =>
      finish(() => reject(new Error("The STEP tessellator could not be loaded."))),
    );
    worker.addEventListener("message", (event: MessageEvent<WorkerResponse>) => {
      const response = event.data;
      if (response.id !== id) return;
      if (response.ok === false) {
        finish(() => reject(new Error(response.error)));
        return;
      }
      try {
        assertStepMeshBounds(response.result);
        finish(() => resolve(response.result));
      } catch (cause) {
        finish(() => reject(cause));
      }
    });
    const transferable = bytes.slice();
    worker.postMessage({ id, bytes: transferable }, [transferable.buffer]);
  });
}

export function buildStepObject(three: typeof THREE, result: StepTessellationResult): THREE.Group {
  assertStepMeshBounds(result);
  const root = new three.Group();
  for (const mesh of result.meshes) {
    const geometry = new three.BufferGeometry();
    geometry.setAttribute("position", new three.BufferAttribute(mesh.positions, 3));
    if (mesh.normals) geometry.setAttribute("normal", new three.BufferAttribute(mesh.normals, 3));
    else geometry.computeVertexNormals();
    geometry.setIndex(new three.BufferAttribute(mesh.indices, 1));
    const color = mesh.color
      ? new three.Color(mesh.color[0], mesh.color[1], mesh.color[2])
      : new three.Color(0xb9bcc2);
    const object = new three.Mesh(
      geometry,
      new three.MeshStandardMaterial({ color, roughness: 0.72, metalness: 0.08 }),
    );
    object.name = mesh.name;
    root.add(object);
  }
  return root;
}
