/** Where an orchestrator writes its canvas, relative to the project workspace. */
export const CANVAS_DIR = ".t3/dashboard";
const CANVAS_ENTRY = "index.html";
/** The orchestrator's list of canvas widgets, in the canvas folder. */
export const CANVAS_MANIFEST = "widgets.json";
/** Per canvas page, assets included. */
export const MAX_CANVAS_BYTES = 4 * 1024 * 1024;
const MAX_CANVASES = 8;

export interface CanvasEntry {
  readonly id: string;
  readonly title: string;
  readonly path: string;
  readonly size: "small" | "medium" | "full";
}

/** Without a manifest the project has one full-width canvas: `index.html`. */
export const DEFAULT_CANVAS: CanvasEntry = {
  id: "canvas",
  title: "Canvas",
  path: CANVAS_ENTRY,
  size: "full",
};

const CANVAS_ID = /^[a-z0-9][a-z0-9-]{0,29}$/;

/**
 * Checks a decoded manifest: unique short ids (they become `canvas:<id>` widget
 * ids), short titles, and `.html` paths that stay inside the canvas folder.
 * Returns the trimmed entries, or the first problem.
 */
export function validateManifest(
  widgets: ReadonlyArray<CanvasEntry>,
): { readonly entries: CanvasEntry[] } | { readonly error: string } {
  if (widgets.length > MAX_CANVASES) {
    return { error: `${CANVAS_MANIFEST} lists more than ${MAX_CANVASES} canvases.` };
  }
  const seen = new Set<string>();
  const entries: CanvasEntry[] = [];
  for (const widget of widgets) {
    const id = widget.id.trim();
    const title = widget.title.trim();
    const path = widget.path.trim();
    if (!CANVAS_ID.test(id)) {
      return { error: `Canvas id "${id}" must be 1-30 lowercase letters, digits or dashes.` };
    }
    if (seen.has(id)) return { error: `Canvas id "${id}" is listed twice.` };
    if (!title || title.length > 60)
      return { error: `Canvas "${id}" needs a title up to 60 characters.` };
    if (
      !path.toLowerCase().endsWith(".html") ||
      /^[a-z][a-z0-9+.-]*:/i.test(path) ||
      path.startsWith("/") ||
      path.startsWith("\\") ||
      path.split(/[\\/]/).includes("..")
    ) {
      return { error: `Canvas "${id}" path must be a .html file inside .t3/dashboard.` };
    }
    seen.add(id);
    entries.push({ id, title, path, size: widget.size });
  }
  return { entries };
}

const MIME: Record<string, string> = {
  css: "text/css",
  js: "text/javascript",
  mjs: "text/javascript",
  json: "application/json",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  csv: "text/csv",
  txt: "text/plain",
};

export function mimeFor(file: string): string | null {
  const extension = file.split(".").pop()?.toLowerCase() ?? "";
  return MIME[extension] ?? null;
}

/**
 * The local asset references in a canvas page: relative `src` and `href`
 * values that stay inside the canvas folder. URLs with a scheme, protocol-relative
 * and absolute paths, fragments, and anything that climbs out with `..` are left
 * alone, so the page can only pull in its own files.
 */
export function localAssetReferences(html: string): string[] {
  const found = new Set<string>();
  for (const match of html.matchAll(/\b(?:src|href)\s*=\s*(["'])([^"']+)\1/gi)) {
    const reference = match[2]!.trim();
    if (
      !reference ||
      /^[a-z][a-z0-9+.-]*:/i.test(reference) ||
      reference.startsWith("/") ||
      reference.startsWith("#") ||
      reference.split(/[\\/]/).includes("..")
    ) {
      continue;
    }
    found.add(reference.split(/[?#]/)[0]!);
  }
  return [...found];
}

/** Replaces each inlined reference with its data URL. */
export function inlineAssets(html: string, dataUrls: ReadonlyMap<string, string>): string {
  return html.replace(
    /\b(src|href)(\s*=\s*)(["'])([^"']+)\3/gi,
    (whole, attribute: string, equals: string, quote: string, reference: string) => {
      const dataUrl = dataUrls.get(reference.trim().split(/[?#]/)[0]!);
      return dataUrl ? `${attribute}${equals}${quote}${dataUrl}${quote}` : whole;
    },
  );
}
