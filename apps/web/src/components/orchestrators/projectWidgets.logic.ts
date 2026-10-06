/** Every widget a project page can show, in the default order. */
const PROJECT_WIDGETS = [
  { id: "requests", title: "Requests" },
  { id: "needs-you", title: "Needs you" },
  { id: "release", title: "Release" },
  { id: "maintenance", title: "Maintenance" },
  { id: "roadmap", title: "Roadmap" },
  { id: "working", title: "Working" },
  { id: "blocked", title: "Blocked" },
  { id: "done", title: "Done since your last visit" },
  // The embedded orchestrator composer; the request box in Requests replaces it by default.
  { id: "new-request", title: "Orchestrator composer", hiddenByDefault: true },
  { id: "issues", title: "Issues" },
  { id: "prs", title: "Pull requests" },
  { id: "canvas", title: "Canvas" },
  { id: "automations", title: "Automations" },
] as const;

export type ProjectWidgetId = (typeof PROJECT_WIDGETS)[number]["id"];

const KNOWN = new Set<string>(PROJECT_WIDGETS.map((widget) => widget.id));

export const DEFAULT_WIDGET_ORDER: ReadonlyArray<ProjectWidgetId> = PROJECT_WIDGETS.filter(
  (widget) => !("hiddenByDefault" in widget),
).map((widget) => widget.id);
const ALL_WIDGETS: ReadonlyArray<ProjectWidgetId> = PROJECT_WIDGETS.map((widget) => widget.id);

/** A canvas widget from the orchestrator's manifest, ordered like any other widget. */
export type CanvasWidgetId = `canvas:${string}`;
export type DashboardWidgetId = ProjectWidgetId | CanvasWidgetId;

export interface CanvasWidgetInfo {
  readonly id: CanvasWidgetId;
  readonly title: string;
}

export const canvasWidgetId = (id: string): CanvasWidgetId => `canvas:${id}`;

export const isCanvasWidget = (id: string): id is CanvasWidgetId => id.startsWith("canvas:");

/**
 * The widgets to render: the saved order (unknown ids dropped), or the default.
 * `canvas` stands for the manifest's canvases not placed on their own, in
 * manifest order; with no canvases it stays, so the page can say why.
 */
export function visibleWidgets(
  saved: ReadonlyArray<string> | null,
  canvases: ReadonlyArray<CanvasWidgetInfo> = [],
): DashboardWidgetId[] {
  const base: ReadonlyArray<string> = saved ?? DEFAULT_WIDGET_ORDER;
  const canvasIds = new Set<string>(canvases.map((canvas) => canvas.id));
  const placed = new Set(base.filter((id) => canvasIds.has(id)));
  const result: DashboardWidgetId[] = [];
  for (const id of base) {
    if (id === "canvas" && canvases.length > 0) {
      result.push(
        ...canvases.map((canvas) => canvas.id).filter((canvasId) => !placed.has(canvasId)),
      );
    } else if (KNOWN.has(id)) {
      result.push(id as ProjectWidgetId);
    } else if (canvasIds.has(id)) {
      result.push(id as CanvasWidgetId);
    }
  }
  return [...new Set(result)];
}

export interface WidgetChoice {
  readonly id: DashboardWidgetId;
  readonly title: string;
  readonly visible: boolean;
}

/**
 * The Customize list: visible widgets in order, then hidden ones in default
 * order. Canvases are listed one by one, so saving places each explicitly and a
 * canvas added to the manifest later starts hidden, like any new widget.
 */
export function widgetChoices(
  saved: ReadonlyArray<string> | null,
  canvases: ReadonlyArray<CanvasWidgetInfo> = [],
): WidgetChoice[] {
  const visible = visibleWidgets(saved, canvases);
  const titleOf = new Map<string, string>([
    ...PROJECT_WIDGETS.map((widget): [string, string] => [widget.id, widget.title]),
    ...canvases.map((canvas): [string, string] => [canvas.id, canvas.title]),
  ]);
  const all: DashboardWidgetId[] = ALL_WIDGETS.flatMap((id) =>
    id === "canvas" && canvases.length > 0 ? canvases.map((canvas) => canvas.id) : [id],
  );
  return [
    ...visible.map((id) => ({ id, title: titleOf.get(id)!, visible: true })),
    ...all
      .filter((id) => !visible.includes(id))
      .map((id) => ({ id, title: titleOf.get(id)!, visible: false })),
  ];
}

/** Moves one choice up or down the list. */
export function moveChoice(
  choices: ReadonlyArray<WidgetChoice>,
  index: number,
  direction: -1 | 1,
): WidgetChoice[] {
  const target = index + direction;
  if (target < 0 || target >= choices.length) return [...choices];
  const next = [...choices];
  [next[index], next[target]] = [next[target]!, next[index]!];
  return next;
}

export const savedOrder = (choices: ReadonlyArray<WidgetChoice>): DashboardWidgetId[] =>
  choices.filter((choice) => choice.visible).map((choice) => choice.id);
