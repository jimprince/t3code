import * as Schema from "effect/Schema";

import { IsoDateTime, ThreadId } from "./baseSchemas.ts";

export const ProjectCanvasReadInput = Schema.Struct({ threadId: ThreadId });
export type ProjectCanvasReadInput = typeof ProjectCanvasReadInput.Type;

/** How much of the page a canvas widget takes: a third, half, or the full width. */
export const ProjectCanvasSize = Schema.Literals(["small", "medium", "full"]);
export type ProjectCanvasSize = typeof ProjectCanvasSize.Type;

/**
 * `<workspace>/.t3/dashboard/widgets.json`: the orchestrator's canvas widgets, in
 * order. Each page path is relative to `.t3/dashboard`.
 */
export const ProjectCanvasManifest = Schema.Struct({
  widgets: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      title: Schema.String,
      path: Schema.String,
      size: ProjectCanvasSize,
    }),
  ),
});
export type ProjectCanvasManifest = typeof ProjectCanvasManifest.Type;

/** One canvas page with its local assets inlined, for a sandboxed frame. */
export const ProjectCanvasPage = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  size: ProjectCanvasSize,
  /** Workspace-relative path the orchestrator writes. */
  path: Schema.String,
  /** Null when the page is missing or over the size cap. */
  html: Schema.NullOr(Schema.String),
  /** Newest modification time of the page and its assets. */
  updatedAt: Schema.NullOr(IsoDateTime),
  /** Assets that were too large or missing and so were left out. */
  skipped: Schema.Array(Schema.String),
});
export type ProjectCanvasPage = typeof ProjectCanvasPage.Type;

/**
 * The orchestrator's canvases: the pages its manifest lists, or without one the
 * single `index.html` canvas. `error` names a manifest problem; no canvases then.
 */
export const ProjectCanvas = Schema.Struct({
  canvases: Schema.Array(ProjectCanvasPage),
  /** Whether `widgets.json` exists; without it the one canvas is `index.html`. */
  manifest: Schema.Boolean,
  error: Schema.NullOr(Schema.String),
});
export type ProjectCanvas = typeof ProjectCanvas.Type;

/** Intents a canvas may post to its host; anything else is rejected. */
export const ProjectCanvasIntent = Schema.Literals([
  "send",
  "open-thread",
  "open-issue",
  "open-url",
  "resize",
]);
export type ProjectCanvasIntent = typeof ProjectCanvasIntent.Type;

/** One canvas intent and what the host did with it, for the server log. */
export const ProjectCanvasActionInput = Schema.Struct({
  threadId: ThreadId,
  canvasId: Schema.String.check(Schema.isMaxLength(40)),
  intent: Schema.String.check(Schema.isMaxLength(40)),
  /** The text sent, or the thread, issue or URL opened (truncated). */
  target: Schema.String.check(Schema.isMaxLength(500)),
  outcome: Schema.Literals(["done", "cancelled", "rejected"]),
  reason: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(200))),
});
export type ProjectCanvasActionInput = typeof ProjectCanvasActionInput.Type;

export class ProjectCanvasError extends Schema.TaggedError<ProjectCanvasError>()(
  "ProjectCanvasError",
  { message: Schema.String },
) {}
