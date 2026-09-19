import { DownloadIcon, ExternalLinkIcon, RotateCcwIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type * as THREE from "three";

import { Button } from "~/components/ui/button";
import { toastManager } from "~/components/ui/toast";
import { cn } from "~/lib/utils";

import { readBoundedModelResponse, validateModelBytes } from "./modelValidation";
import { requestModelRenderSlot } from "./modelRenderSlots";

type Runtime = {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  readonly controls: import("three/examples/jsm/controls/OrbitControls.js").OrbitControls;
  readonly reset: () => void;
  readonly render: () => void;
  readonly dispose: () => void;
};

export function disposeModelObject(root: THREE.Object3D) {
  const disposedTextures = new Set<THREE.Texture>();
  const closedImages = new Set<object>();
  root.traverse((object) => {
    const mesh = object as THREE.Mesh;
    mesh.geometry?.dispose();
    const materials = Array.isArray(mesh.material)
      ? mesh.material
      : mesh.material
        ? [mesh.material]
        : [];
    for (const material of materials) {
      for (const value of Object.values(material)) {
        if (value && typeof value === "object" && "isTexture" in value) {
          const texture = value as THREE.Texture;
          const image = texture.source?.data as { close?: () => void } | undefined;
          if (image && typeof image === "object" && !closedImages.has(image)) {
            closedImages.add(image);
            image.close?.();
          }
          if (!disposedTextures.has(texture)) {
            disposedTextures.add(texture);
            texture.dispose();
          }
        }
      }
      material.dispose();
    }
  });
}

export function allowEmbeddedModelUrl(url: string): string {
  // GLTFLoader creates blob URLs itself for validated image bufferViews.
  if (/^(?:data:image\/(?:png|jpeg);base64,|blob:)/i.test(url)) return url;
  throw new Error("GLB previews cannot load external or relative resources.");
}

export function modelViewportSize(host: Pick<HTMLElement, "clientWidth" | "clientHeight">) {
  return { width: Math.max(1, host.clientWidth), height: Math.max(1, host.clientHeight) };
}

export function modelCanvasKey(url: string, revision: number, slotEpoch: number) {
  return `${url}:${revision}:${slotEpoch}`;
}

export async function refreshModelPreviewUrl(
  currentUrl: string,
  refresh?: () => Promise<unknown>,
): Promise<string> {
  if (!refresh) return currentUrl;
  const refreshed = await refresh();
  if (refreshed === null) throw new Error("Reconnect to the environment and try again.");
  return typeof refreshed === "string" && refreshed.length > 0 ? refreshed : currentUrl;
}

export function canOpenModelInOrcaSlicer(name: string): boolean {
  return (
    typeof window !== "undefined" &&
    name.toLowerCase().endsWith(".stl") &&
    window.desktopBridge?.getClientPlatform?.() === "darwin" &&
    window.desktopBridge.openModelInOrcaSlicer !== undefined
  );
}

export async function openModelInOrcaSlicer(input: {
  readonly url: string;
  readonly name: string;
  readonly bytes?: Uint8Array;
  readonly fetchModel?: typeof fetch;
}) {
  const bridge = window.desktopBridge?.openModelInOrcaSlicer;
  if (!bridge || !input.name.toLowerCase().endsWith(".stl")) {
    throw new Error("Open in OrcaSlicer is available for STL files in T3 Code Desktop on macOS.");
  }
  const controller = new AbortController();
  const bytes =
    input.bytes ??
    (await readBoundedModelResponse(
      await (input.fetchModel ?? fetch)(input.url, { signal: controller.signal }),
      controller.signal,
    ));
  const validated = validateModelBytes(bytes, input.name);
  if (validated.format !== "stl") throw new Error("OrcaSlicer handoff supports STL files only.");
  const result = await bridge({ name: input.name, bytes });
  if (!result.opened) throw new Error(result.error ?? "OrcaSlicer could not be opened.");
}

async function createRuntime(input: {
  canvas: HTMLCanvasElement;
  bytes: Uint8Array;
  name: string;
  signal: AbortSignal;
}): Promise<Runtime> {
  const validated = validateModelBytes(input.bytes, input.name);
  const [three, { GLTFLoader }, { STLLoader }, { OrbitControls }] = await Promise.all([
    import("three"),
    import("three/examples/jsm/loaders/GLTFLoader.js"),
    import("three/examples/jsm/loaders/STLLoader.js"),
    import("three/examples/jsm/controls/OrbitControls.js"),
  ]);
  if (input.signal.aborted) throw input.signal.reason;
  let root: THREE.Object3D;
  if (validated.format === "glb") {
    const manager = new three.LoadingManager();
    manager.setURLModifier(allowEmbeddedModelUrl);
    const loader = new GLTFLoader(manager);
    const gltf = await new Promise<import("three/examples/jsm/loaders/GLTFLoader.js").GLTF>(
      (resolve, reject) => loader.parse(validated.bytes, "", resolve, reject),
    );
    root = gltf.scene;
  } else {
    const geometry = new STLLoader().parse(validated.bytes);
    geometry.computeVertexNormals();
    root = new three.Mesh(
      geometry,
      new three.MeshStandardMaterial({ color: 0xb9bcc2, roughness: 0.72, metalness: 0.08 }),
    );
  }
  if (input.signal.aborted) {
    disposeModelObject(root);
    throw input.signal.reason;
  }
  let renderer: THREE.WebGLRenderer | null = null;
  let controls: import("three/examples/jsm/controls/OrbitControls.js").OrbitControls | null = null;
  try {
    renderer = new three.WebGLRenderer({ canvas: input.canvas, antialias: true, alpha: false });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
    renderer.setClearColor(0x000000, 1);
    renderer.outputColorSpace = three.SRGBColorSpace;
    const scene = new three.Scene();
    scene.background = new three.Color(0x000000);
    const camera = new three.PerspectiveCamera(42, 1, 0.01, 10_000);
    controls = new OrbitControls(camera, input.canvas);
    controls.enableDamping = false;
    controls.autoRotate = false;
    controls.enablePan = true;
    scene.add(root);
    scene.add(new three.HemisphereLight(0xffffff, 0x303030, 2.1));
    const key = new three.DirectionalLight(0xffffff, 2.4);
    key.position.set(3, 4, 5);
    scene.add(key);
    const box = new three.Box3().setFromObject(root);
    if (box.isEmpty()) throw new Error("The model contains no visible geometry.");
    const sphere = box.getBoundingSphere(new three.Sphere());
    const center = sphere.center.clone();
    const radius = Math.max(sphere.radius, 0.001);
    const initialPosition = center
      .clone()
      .add(new three.Vector3(1, 0.7, 1).normalize().multiplyScalar(radius * 2.8));
    const reset = () => {
      camera.near = Math.max(radius / 1000, 0.001);
      camera.far = Math.max(radius * 100, 100);
      camera.position.copy(initialPosition);
      camera.updateProjectionMatrix();
      controls!.target.copy(center);
      controls!.update();
    };
    const render = () => renderer!.render(scene, camera);
    reset();
    controls.addEventListener("change", render);
    let disposed = false;
    return {
      renderer,
      scene,
      camera,
      controls,
      reset,
      render,
      dispose: () => {
        if (disposed) return;
        disposed = true;
        controls!.removeEventListener("change", render);
        controls!.dispose();
        disposeModelObject(root);
        renderer!.dispose();
        renderer!.forceContextLoss();
      },
    };
  } catch (cause) {
    controls?.dispose();
    disposeModelObject(root);
    renderer?.dispose();
    renderer?.forceContextLoss();
    throw cause;
  }
}

export default function ModelViewer(props: {
  readonly url: string;
  readonly name: string;
  readonly className?: string;
  readonly onDownload?: () => void;
  readonly onRetry?: () => Promise<unknown>;
}) {
  const { onRetry } = props;
  const hostRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const runtimeRef = useRef<Runtime | null>(null);
  const modelBytesRef = useRef<Uint8Array | null>(null);
  const handoffPendingRef = useRef(false);
  const [handoffPending, setHandoffPending] = useState(false);
  const [visible, setVisible] = useState(false);
  const [hasSlot, setHasSlot] = useState(false);
  const [slotEpoch, setSlotEpoch] = useState(0);
  const [revision, setRevision] = useState(0);
  const [retryUrl, setRetryUrl] = useState<{ readonly base: string; readonly url: string } | null>(
    null,
  );
  const [status, setStatus] = useState<"waiting" | "loading" | "ready" | "error">("waiting");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const element = hostRef.current;
    if (!element) return;
    if (typeof IntersectionObserver === "undefined") {
      // oxlint-disable-next-line react/set-state-in-effect -- Non-browser renderers have no visibility signal, so treat the mounted preview as visible.
      setVisible(true);
      return;
    }
    const observer = new IntersectionObserver(
      ([entry]) => setVisible(entry?.isIntersecting === true),
      {
        rootMargin: "0px",
      },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!visible) {
      // oxlint-disable-next-line react/set-state-in-effect -- Losing visibility synchronously releases the scarce WebGL slot.
      setHasSlot(false);
      return;
    }
    return requestModelRenderSlot(() => {
      setSlotEpoch((value) => value + 1);
      setHasSlot(true);
    });
  }, [visible]);

  const activeUrl = retryUrl?.base === props.url ? retryUrl.url : props.url;
  useEffect(() => {
    const canvas = canvasRef.current;
    const host = hostRef.current;
    if (!hasSlot || !visible || !canvas || !host) return;
    const controller = new AbortController();
    let runtime: Runtime | null = null;
    let observer: ResizeObserver | null = null;
    modelBytesRef.current = null;
    setStatus("loading");
    setError(null);
    void (async () => {
      const response = await fetch(activeUrl, {
        signal: controller.signal,
        cache: revision ? "reload" : "default",
      });
      const bytes = await readBoundedModelResponse(response, controller.signal);
      runtime = await createRuntime({
        canvas,
        bytes,
        name: props.name,
        signal: controller.signal,
      });
      modelBytesRef.current = bytes;
      runtimeRef.current = runtime;
      const resize = () => {
        if (!runtime) return;
        const { width, height } = modelViewportSize(host);
        runtime.renderer.setSize(width, height, false);
        runtime.camera.aspect = width / height;
        runtime.camera.updateProjectionMatrix();
        runtime.render();
      };
      observer = new ResizeObserver(resize);
      observer.observe(host);
      resize();
      if (!controller.signal.aborted) setStatus("ready");
    })().catch((cause: unknown) => {
      if (controller.signal.aborted) return;
      setStatus("error");
      setError(cause instanceof Error ? cause.message : "Unable to preview this model.");
    });
    const contextLost = (event: Event) => {
      event.preventDefault();
      runtime?.dispose();
      runtime = null;
      runtimeRef.current = null;
      setStatus("error");
      setError("The WebGL context was lost. Retry the preview.");
    };
    canvas.addEventListener("webglcontextlost", contextLost);
    return () => {
      controller.abort();
      modelBytesRef.current = null;
      observer?.disconnect();
      canvas.removeEventListener("webglcontextlost", contextLost);
      if (runtimeRef.current === runtime) runtimeRef.current = null;
      runtime?.dispose();
    };
    // A new slot epoch remounts the keyed canvas, so it must also recreate the runtime.
    // oxlint-disable-next-line react/exhaustive-effect-dependencies
  }, [activeUrl, hasSlot, props.name, revision, slotEpoch, visible]);

  const retry = useCallback(() => {
    setStatus("loading");
    setError(null);
    void (async () => {
      try {
        const refreshed = await refreshModelPreviewUrl(props.url, onRetry);
        if (refreshed !== props.url) setRetryUrl({ base: props.url, url: refreshed });
        setRevision((value) => value + 1);
      } catch (cause) {
        setStatus("error");
        setError(cause instanceof Error ? cause.message : "Unable to refresh this model.");
      }
    })();
  }, [onRetry, props.url]);
  const openInOrcaSlicer = useCallback(() => {
    if (handoffPendingRef.current) return;
    handoffPendingRef.current = true;
    setHandoffPending(true);
    void openModelInOrcaSlicer({
      url: activeUrl,
      name: props.name,
      ...(modelBytesRef.current === null ? {} : { bytes: modelBytesRef.current }),
    })
      .catch((cause: unknown) => {
        toastManager.add({
          type: "error",
          title: "Could not open OrcaSlicer",
          description: cause instanceof Error ? cause.message : "Please try again.",
        });
      })
      .finally(() => {
        handoffPendingRef.current = false;
        setHandoffPending(false);
      });
  }, [activeUrl, props.name]);
  return (
    <div
      ref={hostRef}
      className={cn("relative min-h-56 overflow-hidden bg-black text-white", props.className)}
    >
      <canvas
        key={modelCanvasKey(activeUrl, revision, slotEpoch)}
        ref={canvasRef}
        aria-label={`3D preview of ${props.name}`}
        className="absolute inset-0 block size-full touch-none"
      />
      {status !== "ready" ? (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-black px-6 text-center text-xs text-white/75">
          <p>{status === "error" ? error : hasSlot ? "Loading 3D model…" : "Waiting to render…"}</p>
          {status === "error" ? (
            <Button size="sm" variant="secondary" onClick={retry}>
              Retry
            </Button>
          ) : null}
        </div>
      ) : null}
      <div className="absolute right-2 bottom-2 flex gap-1">
        <Button
          size="icon-xs"
          variant="secondary"
          aria-label="Reset 3D view"
          onClick={() => {
            runtimeRef.current?.reset();
            runtimeRef.current?.render();
          }}
        >
          <RotateCcwIcon />
        </Button>
        {props.onDownload ? (
          <Button
            size="icon-xs"
            variant="secondary"
            aria-label={`Download ${props.name}`}
            onClick={props.onDownload}
          >
            <DownloadIcon />
          </Button>
        ) : null}
        {canOpenModelInOrcaSlicer(props.name) ? (
          <Button
            size="compact"
            variant="secondary"
            aria-label={`Open ${props.name} in OrcaSlicer`}
            disabled={handoffPending}
            onClick={openInOrcaSlicer}
          >
            <ExternalLinkIcon />
            {handoffPending ? "Opening…" : "Open in OrcaSlicer"}
          </Button>
        ) : null}
      </div>
    </div>
  );
}
