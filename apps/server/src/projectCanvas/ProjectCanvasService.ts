import {
  ProjectCanvasError,
  ProjectCanvasManifest,
  type ProjectCanvas,
  type ProjectCanvasActionInput,
  type ProjectCanvasPage,
  type ProjectCanvasReadInput,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { listMetadata } from "../forkThreads/MetadataStore.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import { findProjectRootThreadId } from "../projectIssues/projectIssues.logic.ts";
import {
  CANVAS_DIR,
  CANVAS_MANIFEST,
  DEFAULT_CANVAS,
  inlineAssets,
  localAssetReferences,
  MAX_CANVAS_BYTES,
  mimeFor,
  validateManifest,
  type CanvasEntry,
} from "./projectCanvas.logic.ts";

const fail = (message: string) => new ProjectCanvasError({ message });
const decodeManifest = Schema.decodeUnknownEffect(Schema.fromJsonString(ProjectCanvasManifest));

/**
 * Serves an orchestrator's canvases read-only: the static pages it lists in
 * `<workspace>/.t3/dashboard/widgets.json` (or `index.html` without one), each
 * with its own files from its folder inlined as data URLs so the client can show
 * it in a sandboxed frame that has no network path back into T3.
 */
export const make = Effect.gen(function* () {
  const engine = yield* ThreadManagement.ThreadManagementService;
  const projectService = yield* ProjectService.ProjectService;
  const sql = yield* SqlClient.SqlClient;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const modifiedMs = (file: string) =>
    fileSystem.stat(file).pipe(
      Effect.map((info) =>
        info.type === "File"
          ? { size: Number(info.size), mtime: Option.getOrUndefined(info.mtime)?.getTime() ?? 0 }
          : null,
      ),
      Effect.orElseSucceed(() => null),
    );

  /** One page, with its own files (inside the page's folder) inlined. */
  const readPage = (dir: string, entry: CanvasEntry) =>
    Effect.gen(function* () {
      const page: ProjectCanvasPage = {
        id: entry.id,
        title: entry.title,
        size: entry.size,
        path: `${CANVAS_DIR}/${entry.path}`,
        html: null,
        updatedAt: null,
        skipped: [],
      };
      const file = path.resolve(dir, entry.path);
      if (!file.startsWith(dir + path.sep)) return page;
      const pageDir = path.dirname(file);
      const entryInfo = yield* modifiedMs(file);
      if (!entryInfo || entryInfo.size > MAX_CANVAS_BYTES) return page;
      const html = yield* fileSystem
        .readFileString(file)
        .pipe(Effect.mapError(() => fail("Could not read the canvas page.")));

      let total = entryInfo.size;
      let newest = entryInfo.mtime;
      const dataUrls = new Map<string, string>();
      const skipped: string[] = [];
      for (const reference of localAssetReferences(html)) {
        const asset = path.resolve(pageDir, reference);
        const mime = mimeFor(asset);
        const info = asset.startsWith(pageDir + path.sep) && mime ? yield* modifiedMs(asset) : null;
        if (!info || !mime || total + info.size > MAX_CANVAS_BYTES) {
          skipped.push(reference);
          continue;
        }
        const bytes = yield* fileSystem.readFile(asset).pipe(Effect.orElseSucceed(() => null));
        if (!bytes) {
          skipped.push(reference);
          continue;
        }
        total += info.size;
        newest = Math.max(newest, info.mtime);
        dataUrls.set(reference, `data:${mime};base64,${Buffer.from(bytes).toString("base64")}`);
      }
      return {
        ...page,
        html: inlineAssets(html, dataUrls),
        updatedAt: newest > 0 ? DateTime.formatIso(DateTime.makeUnsafe(newest)) : null,
        skipped,
      } satisfies ProjectCanvasPage;
    });

  /** The canvas widgets `widgets.json` lists, or the one `index.html` canvas without it. */
  const read = (input: ProjectCanvasReadInput) =>
    Effect.gen(function* () {
      const snapshot = yield* engine
        .getShellSnapshot()
        .pipe(Effect.mapError(() => fail("Could not read threads.")));
      const parents = new Map(
        (yield* listMetadata(sql).pipe(
          Effect.mapError(() => fail("Could not read thread parents.")),
        )).map((row) => [row.threadId, row]),
      );
      const threads = [...snapshot.threads, ...snapshot.archivedThreads].map((thread) => ({
        ...thread,
        parentThreadId: parents.get(thread.id)?.parentThreadId ?? null,
        subproject: parents.get(thread.id)?.subproject ?? "auto",
      }));
      const rootThreadId = findProjectRootThreadId(threads, input.threadId);
      const root = threads.find((thread) => thread.id === rootThreadId);
      const project = root
        ? Option.getOrNull(
            yield* projectService
              .getShell(root.projectId)
              .pipe(Effect.mapError(() => fail("Could not read projects."))),
          )
        : null;
      if (!project) {
        return { canvases: [], manifest: false, error: null } satisfies ProjectCanvas;
      }
      const dir = path.resolve(project.workspaceRoot, CANVAS_DIR);
      const manifestFile = path.join(dir, CANVAS_MANIFEST);
      const manifest = (yield* modifiedMs(manifestFile))
        ? yield* fileSystem.readFileString(manifestFile).pipe(
            Effect.flatMap(decodeManifest),
            Effect.map((decoded) => validateManifest(decoded.widgets)),
            Effect.orElseSucceed(() => ({
              error: `${CANVAS_DIR}/${CANVAS_MANIFEST} is not a valid canvas manifest.`,
            })),
          )
        : null;
      if (manifest && "error" in manifest) {
        return { canvases: [], manifest: true, error: manifest.error } satisfies ProjectCanvas;
      }
      const canvases = yield* Effect.forEach(manifest?.entries ?? [DEFAULT_CANVAS], (entry) =>
        readPage(dir, entry),
      );
      return { canvases, manifest: manifest !== null, error: null } satisfies ProjectCanvas;
    });

  /**
   * Records what a canvas asked its host to do and what the host did, so canvas
   * actions are auditable: the frame itself never reaches the server.
   */
  const logAction = (input: ProjectCanvasActionInput) =>
    Effect.logInfo("project canvas action").pipe(
      Effect.annotateLogs({
        threadId: input.threadId,
        canvasId: input.canvasId,
        intent: input.intent,
        target: input.target,
        outcome: input.outcome,
        ...(input.reason ? { reason: input.reason } : {}),
      }),
    );

  return { read, logAction };
});
