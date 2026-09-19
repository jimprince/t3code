# Inline 3D objects

## Status and stack baseline

Implemented as the independently droppable `fork-inline-3d-objects` concern. The feature patch is based on `54d8c4dd33234f4e83d2a006139801e94f09c212`, after the 30 previously existing patches in `stgit/adopt`. The owning patch depends on `fork-attachment-compatibility` and `fork-remote-file-downloads`. `pnpm-lock.yaml` remains owned by the earlier `lockfile-owner` concern when the stack is captured.

The implementation follows the approved direction: lazy bare Three.js for GLB and STL, reuse of durable attachments and signed asset URLs, exact workspace-file capabilities, and a native React Native placeholder/open flow. It does not introduce server conversion, a new attachment type, a new storage directory, or a directory-scoped model grant.

## Existing data flow and ownership

The design review derived ownership from each patch's own `diff-tree`, not from the cumulative tree. The paths remain useful conflict and retirement references even though line numbers move during upstream replay.

| Stage               | Source and behavior                                                                                                                                                                                         | Existing concern                                                                                                                                                     |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Attachment contract | `packages/contracts/src/orchestration.ts` supports image, file, and unknown attachments, with eight attachments per message, 10 MiB images, and 50 MiB generic files.                                       | `fork-attachment-compatibility`, `fork-conversation-fork`, `fork-general-chat`, `fork-thread-history-compatibility`, and `fork-thread-transfer` overlap this schema. |
| Web intake          | `apps/web/src/components/chat/ChatComposer.tsx` and `apps/web/src/lib/attachmentUploadQueue.ts` classify picker/drop/paste files, enforce limits, upload bytes, and retain IDs.                             | Upstream surface.                                                                                                                                                    |
| Upload protocol     | `packages/contracts/src/assets.ts`, `packages/client-runtime/src/state/attachments.ts`, and `apps/server/src/assets/AttachmentUpload.ts` mint ten-minute upload URLs and serve `/api/attachments/upload/*`. | Asset contracts overlap `fork-remote-file-downloads`; upload service remains upstream.                                                                               |
| Durable storage     | `apps/server/src/attachmentStore.ts`, `attachmentPaths.ts`, and `orchestration/Normalizer.ts` claim pending uploads into thread-owned storage.                                                              | Reused unchanged.                                                                                                                                                    |
| Persistence         | `ProjectionThreadMessages.ts` and `ProjectionPipeline.ts` persist message attachment metadata and retain referenced bytes during cleanup.                                                                   | `fork-attachment-compatibility`.                                                                                                                                     |
| Provider input      | `provider/Layers/ProviderService.ts` resolves stored attachments to local paths; adapters provide additional native handling where supported.                                                               | Reused.                                                                                                                                                              |
| Signed reads        | `apps/server/src/assets/AssetAccess.ts` and `apps/server/src/http.ts` mint one-hour `/api/assets/*` URLs and serve authorized files.                                                                        | `fork-remote-file-downloads`; this feature adds model-specific exact claims and limits.                                                                              |
| Timeline            | `apps/web/src/components/chat/MessagesTimeline.tsx` renders current attachments.                                                                                                                            | Overlaps compatibility, conversation-fork, and thread recovery.                                                                                                      |
| Attachment preview  | `apps/web/src/components/files/AttachmentFilePreview.tsx` accepts a Blob or stored attachment reference and retains download actions.                                                                       | Small feature hook.                                                                                                                                                  |
| Workspace preview   | `FilePreviewPanel.tsx` and `packages/shared/src/filePreview.ts` classify and display workspace files.                                                                                                       | Small feature hook.                                                                                                                                                  |
| Agent file links    | `ChatMarkdown.tsx` and `packages/client-runtime/src/markdown-links.ts` resolve worktree links and open file panels.                                                                                         | `ChatMarkdown.tsx` overlaps `fork-remote-file-downloads`.                                                                                                            |
| Native mobile       | `AttachmentFileScreen.tsx`, `ThreadFilesRouteScreen.tsx`, `FilePreview.tsx`, and `attachmentDocument.ts` use native viewers and source previews.                                                            | Native fallback only; no native WebGL.                                                                                                                               |

The historical `fileAttachments` field is a separate path-bearing compatibility route with a 32 MiB limit and `/tmp` handoffs. This feature deliberately uses current durable `attachments` instead.

## Format and renderer decision

| Format  | V1 decision                                                                                  | Reason                                                                                                                               |
| ------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| GLB     | Render directly with `GLTFLoader`; embedded resources only.                                  | One-file transport and no server conversion.                                                                                         |
| STL     | Render binary and a strict, realistic ASCII subset with `STLLoader`; use a neutral material. | Common printable geometry and no companion resources.                                                                                |
| `.gltf` | Deferred.                                                                                    | Companion buffers/textures require a multi-file authorization model; export as GLB instead.                                          |
| OBJ     | Deferred.                                                                                    | Useful loader exists, but MTL, texture, and multi-file resolution expand the capability surface.                                     |
| 3MF     | Render directly with `ThreeMFLoader` after bounded package validation.                       | Preserves core assemblies and basic material/color groups without server conversion; applies the declared model unit in millimeters. |
| STEP    | Deferred to optional conversion.                                                             | Browser display requires CAD tessellation in WASM or a service.                                                                      |

Official loader references: [GLTFLoader](https://threejs.org/docs/pages/GLTFLoader.html), [STLLoader](https://threejs.org/docs/pages/STLLoader.html), [OBJLoader](https://threejs.org/docs/pages/OBJLoader.html), and [ThreeMFLoader](https://threejs.org/docs/pages/ThreeMFLoader.html).

| Renderer option             | Assessment                                                                                                                  |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Bare Three.js               | Selected. One renderer handles both formats and makes demand rendering, validation boundaries, and disposal explicit.       |
| `<model-viewer>`            | Convenient for GLB/glTF, but STL would require conversion or a second renderer.                                             |
| React Three Fiber           | Valuable for complex scenes or a separate native implementation, but adds a reconciler without helping this bounded viewer. |
| External open/download only | Kept as the fallback; it does not satisfy inline web preview.                                                               |

The design estimate was 150-250 KB gzip for a focused Three.js path, with an estimated extra 30-70 KB for React Three Fiber or roughly 250-500 KB for `<model-viewer>`. Those were uncertain planning estimates. The final corrective production build measured separate lazy chunks of approximately 19.55 KB for `ModelViewer`, 2.97 KB for `STLLoader`, 46.01 KB / 13.68 KB gzip for `GLTFLoader`, and 736.64 KB / 186.90 KB gzip for `three.module`. Demand-render guidance: [React Three Fiber scaling performance](https://r3f.docs.pmnd.rs/advanced/scaling-performance). `<model-viewer>` reference: [loading examples](https://modelviewer.dev/examples/loading/).

## Upstream research

The accepted design research searched open and closed upstream pull requests, issues, and discussions. It found:

- [Draft PR #8810](https://github.com/pingdotgg/t3code/pull/8810), an Android external GLB handoff using exact-file assets.
- [Closed PR #7692](https://github.com/pingdotgg/t3code/pull/7692), native Android GLB rendering.
- No relevant upstream web-inline or STL proposal in the searched results.

These findings explain the `divergence` classification. They are a point-in-time research result, not a guarantee that no newer upstream work exists.

## Implemented behavior

### Web, desktop, and remote clients

- Shared preview classification recognizes `.glb` and `.stl` as `model`.
- Current durable file attachments render in the user-message timeline and `AttachmentFilePreview`.
- Workspace file-tree selection routes models to the viewer before any text read or syntax highlighting.
- A standalone assistant Markdown worktree link renders the model inline. A link mixed with prose remains the ordinary file-panel link.
- The shared provider instruction asks agents to emit a standalone Markdown link after generating GLB or STL. Merely writing a file does not create an artifact entry.
- Electron inherits the web renderer without IPC or CSP changes. A remote/headless server only stores, authorizes, and streams bytes.

### Native mobile

Native React Native does not add WebGL. Captured and workspace models are treated as binary documents, display an honest unsupported-preview state, retain platform open/save/share behavior where available, and never enter the source-text read or preload path. Mobile web inherits the browser viewer.

### Viewer interaction and lifecycle

- Lazy imports keep Three.js, `GLTFLoader`, `STLLoader`, and `OrbitControls` out of the initial application chunk.
- The presentation is a static black canvas with neutral STL material, bounds-based camera fitting, orbit, zoom, and reset.
- Rendering occurs after load, resize, controls changes, and reset. There is no animation loop, damping, auto-rotation, or animation playback.
- Device pixel ratio is capped at 1.5 and a process-wide scheduler grants at most two visible WebGL contexts.
- Each runtime owns a fresh canvas. Leaving visibility, replacement, retry, context loss, or unmount aborts stale reads and disposes controls, geometry, materials, textures, owned image bitmaps, renderer state, and the WebGL context.
- The host has stable layout dimensions and the resize observer measures the host rather than canvas intrinsic dimensions.
- Loading, waiting-for-slot, validation failure, URL refresh failure, WebGL failure, context loss, retry, reset, and download states are finite. A rejected refresh remains a visible error instead of becoming an unhandled promise rejection or restarting with a stale URL.

## Trust and resource boundaries

- Preview URLs retain authentication, signature and expiry checks, canonical path validation, and regular-file checks.
- Workspace models receive `workspace-file-exact`, not the sibling-readable capability used by HTML documents. Downloads use the existing `workspace-file-download` capability. No model path extends the arbitrary host `media-file` capability.
- The 50 MiB ceiling restricts preview issuance and resolution only. Oversized workspace and captured models still resolve through download claims.
- Preview resolution opens the model once and checks the limit against that descriptor. HTTP streams from the same descriptor and bounded size, closing the validation-to-open race for model previews.
- The browser checks declared and observed response size and cancels the reader immediately on overflow.
- GLB and STL content is validated before renderer allocation. Limits are two million rendered triangles, six million accessor elements, 256 MiB aggregate decoded accessor shape, 100,000 graph entries, and 64 megapixels across embedded textures.
- GLB accessors must point inside the single embedded BIN chunk. Sparse accessors, missing buffer views, node cycles, multi-parent node graphs, GPU instancing, unsupported required extensions, and Draco/Meshopt/Basis compression are rejected. Mesh reuse through separate nodes is counted per rendered node.
- Only embedded PNG and JPEG images are accepted. JSON validation rejects URI fields outside top-level image records; the Three.js `LoadingManager` independently refuses every URL except validated PNG/JPEG data URLs and loader-created blob URLs. Relative files, remote URLs, SVG, scripts, HTML, and external decoder paths cannot load.
- ASCII STL accepts named solids and ordinary decimal/exponent coordinates but requires complete facets and finite values. Binary STL requires exact declared length and finite normals/vertices.
- Model data is never interpolated into HTML and model animations are not played. Existing Electron CSP remains unchanged; no remote script origin or `unsafe-eval` is required.
- Signed bearer URLs are not handed to third-party web viewers or written to logs.

## Patch ownership and conflict surface

`fork-inline-3d-objects` owns the implementation, focused tests, this proposal, its release note, and its final inventory stanza. Main paths:

- Classification and contracts: `packages/shared/src/filePreview.ts`, `packages/contracts/src/assets.ts`
- Authorization and guidance: `apps/server/src/assets/AssetAccess.ts`, `apps/server/src/provider/RuntimeInstructions.ts`
- Additive web modules: `apps/web/src/components/model/modelValidation.ts`, `modelRenderSlots.ts`, `ModelViewer.tsx`, `ModelPreview.tsx`
- Web hooks: `AttachmentFilePreview.tsx`, `FilePreviewPanel.tsx`, `MessagesTimeline.tsx`, `ChatMarkdown.tsx`
- Native fallback: `apps/mobile/src/lib/attachmentDocument.ts`, `features/files/AttachmentFileScreen.tsx`, `ThreadFilesRouteScreen.tsx`, and `preload-workspace-file.ts`
- Product records: `docs/release-notes/entries/inline-3d-model-previews.toml` and `docs/operations/fork-inventory.toml`

Most code is additive. Ongoing replay conflict risk is concentrated in `AssetAccess.ts`, the four web integration components, mobile file routes, `packages/contracts/src/assets.ts`, dependency manifests, and the generated lockfile. There are no provider-adapter, persistence-schema, upload-protocol, Electron IPC, or server conversion changes. The patch retires when upstream provides equivalent secure, demand-rendered GLB/STL support across attachment, workspace, standalone-link, and native-fallback surfaces.

## Verification and remaining evidence

The final focused suite passed 209 tests across 11 files; shared, contracts, web, server, and mobile typechecks passed; targeted lint and formatting, release-note validation, and `git diff --check` passed. The final production web build transformed 6,068 modules in 1m19s and emitted only the normal large-chunk warning. Corrective coverage includes malformed named ASCII STL, non-finite STL, required-extension, external-extension-URI, accessor-allocation, sparse-accessor, node-cycle, multi-parent, streamed-overflow cancellation, oversized-download, and resource-disposal cases.

Independent headless Chromium verification rendered a GLB triangle and both binary and named ASCII STL fixtures through the production component. Orbit and reset triggered draws; each settled fixture and the post-interaction interval recorded zero idle draw calls. At a device DPR of 2, the 940 × 320 CSS canvas used a stable 1410 × 480 drawing buffer, confirming the 1.5 cap. Forced WebGL context loss recovered through Retry. This is real component rendering, not authenticated end-to-end upload/timeline verification. Packaged Electron, embedded-texture CSP behavior, native-device actions, and prolonged GPU-memory behavior remain unverified. The two-context queue is covered by focused tests.

## Follow-ups

1. Improved native external handoff once platform behavior is consistent across iOS and Android.
2. Explicit provider artifact registration so generated files can appear without relying on a standalone Markdown link.
3. Optional STEP tessellation through a separately reviewed CAD/WASM or conversion-service boundary.
4. Revisit upstream retirement if the draft/closed Android work becomes a complete cross-surface implementation.
