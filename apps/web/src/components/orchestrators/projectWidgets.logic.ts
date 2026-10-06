/** Every widget a project page can show, in the default order. */
const PROJECT_WIDGETS = [
  { id: "requests", title: "Requests" },
  { id: "needs-you", title: "Needs you" },
  { id: "release", title: "Release" },
  { id: "roadmap", title: "Roadmap" },
  { id: "working", title: "Working" },
  { id: "blocked", title: "Blocked" },
  { id: "done", title: "Done since your last visit" },
  { id: "new-request", title: "New request" },
  { id: "issues", title: "Issues" },
  { id: "prs", title: "Pull requests" },
  { id: "canvas", title: "Canvas" },
  { id: "automations", title: "Automations" },
] as const;

export type ProjectWidgetId = (typeof PROJECT_WIDGETS)[number]["id"];

const KNOWN = new Set<string>(PROJECT_WIDGETS.map((widget) => widget.id));

export const DEFAULT_WIDGET_ORDER: ReadonlyArray<ProjectWidgetId> = PROJECT_WIDGETS.map(
  (widget) => widget.id,
);

/** The widgets to render: the saved order (unknown ids dropped), or the default. */
export function visibleWidgets(saved: ReadonlyArray<string> | null): ProjectWidgetId[] {
  if (saved === null) return [...DEFAULT_WIDGET_ORDER];
  return saved.filter((id): id is ProjectWidgetId => KNOWN.has(id));
}

export interface WidgetChoice {
  readonly id: ProjectWidgetId;
  readonly title: string;
  readonly visible: boolean;
}

/** The Customize list: visible widgets in order, then hidden ones in default order. */
export function widgetChoices(saved: ReadonlyArray<string> | null): WidgetChoice[] {
  const visible = visibleWidgets(saved);
  const titleOf = new Map(PROJECT_WIDGETS.map((widget) => [widget.id, widget.title]));
  return [
    ...visible.map((id) => ({ id, title: titleOf.get(id)!, visible: true })),
    ...DEFAULT_WIDGET_ORDER.filter((id) => !visible.includes(id)).map((id) => ({
      id,
      title: titleOf.get(id)!,
      visible: false,
    })),
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

export const savedOrder = (choices: ReadonlyArray<WidgetChoice>): ProjectWidgetId[] =>
  choices.filter((choice) => choice.visible).map((choice) => choice.id);
