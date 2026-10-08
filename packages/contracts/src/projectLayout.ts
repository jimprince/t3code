import * as Schema from "effect/Schema";

import { IsoDateTime, NonNegativeInt, ThreadId } from "./baseSchemas.ts";

/**
 * A project page's layout: tabs, each an ordered list of widgets, one shared
 * document per project (keyed by its orchestrator thread). Brad's drag and drop,
 * the orchestrator's MCP tools and the CLI all change it with the same ops.
 */

export const PROJECT_LAYOUT_LIMITS = {
  tabs: 12,
  widgetsPerTab: 30,
  title: 60,
  id: 40,
  text: 20_000,
  links: 30,
  history: 50,
} as const;

export const ProjectWidgetSize = Schema.Literals(["small", "medium", "full"]);
export type ProjectWidgetSize = typeof ProjectWidgetSize.Type;

/** A settings field of a widget type, so editors and agents know what to set. */
export interface ProjectWidgetConfigField {
  readonly key: string;
  readonly kind: "boolean" | "integer" | "text" | "canvas" | "links";
  readonly label: string;
  readonly description: string;
  readonly default?: boolean | number | string | ReadonlyArray<{ label: string; url: string }>;
  readonly min?: number;
  readonly max?: number;
  /** A widget of this type cannot exist without it. */
  readonly required?: boolean;
}

export interface ProjectWidgetType {
  readonly type: string;
  readonly title: string;
  readonly description: string;
  readonly fields: ReadonlyArray<ProjectWidgetConfigField>;
}

const includeLater: ProjectWidgetConfigField = {
  key: "includeLater",
  kind: "boolean",
  label: "Include Later",
  description: "Also show items saved for later (parked on the roadmap); off keeps Later off.",
  default: false,
};

/** Every widget a layout can hold. Unknown types are rejected. */
export const PROJECT_WIDGET_TYPES: ReadonlyArray<ProjectWidgetType> = [
  {
    type: "needs-you",
    title: "Needs you",
    description:
      "Folded into the Decisions widget. A layout with Decisions shows nothing here; one without it shows the Decisions feed in this place.",
    fields: [],
  },
  {
    type: "decisions",
    title: "Decisions",
    description:
      "Everything waiting on Brad in one feed: threads' questions, approvals and plans, decisions (tracker issues labeled needs-brad), answers to read, and work to review or test. Cards name who they are for and in which project; blocked threads lead, then oldest first. Cards can be answered, approved and merged, sent back, settled, deferred (Later) and filtered by project.",
    fields: [],
  },
  {
    type: "requests",
    title: "Requests",
    description: "Brad's requests still with the agents or waiting for a release.",
    fields: [includeLater],
  },
  {
    type: "release",
    title: "Release",
    description:
      "Completed tasks by the release that shipped them, and what is built and awaiting release.",
    fields: [],
  },
  {
    type: "maintenance",
    title: "Maintenance",
    description: "Open upkeep tasks that do not need Brad.",
    fields: [includeLater],
  },
  {
    type: "roadmap-summary",
    title: "Roadmap summary",
    description:
      "Where we're going: the next release (outcome, N of M done, next task), its epics with progress and phase, and Later as one count, linking to a tab with the roadmap board.",
    fields: [],
  },
  {
    type: "roadmap-board",
    title: "Roadmap",
    description:
      "The roadmap board: next version, later versions and Later, each task with its status (an epic with its progress and phase) and each version with a progress line.",
    fields: [],
  },
  {
    type: "issues-summary",
    title: "Tasks summary",
    description: "One line of task counts per status linking to a tab with the Tasks board.",
    fields: [includeLater],
  },
  {
    type: "issues-board",
    title: "Tasks",
    description:
      "Every task (tracker issue) of the project in status lanes: For review, Active, Pending, Complete; settle or reopen in place.",
    fields: [
      {
        key: "pendingPreview",
        kind: "integer",
        label: "Pending shown",
        description: "Pending cards shown before 'Show all'.",
        default: 10,
        min: 1,
        max: 100,
      },
    ],
  },
  {
    type: "prs",
    title: "Pull requests",
    description: "Pull requests by what they need, merged ones folded.",
    fields: [],
  },
  {
    type: "automations",
    title: "Automations",
    description: "The project's automations and scripts.",
    fields: [],
  },
  {
    type: "composer",
    title: "Orchestrator composer",
    description: "The orchestrator chat composer embedded in the page.",
    fields: [],
  },
  {
    type: "canvas",
    title: "Canvas",
    description: "One canvas page from the orchestrator's .t3/dashboard manifest.",
    fields: [
      {
        key: "canvasId",
        kind: "canvas",
        label: "Canvas",
        description: "The canvas id from widgets.json.",
        required: true,
      },
    ],
  },
  {
    type: "canvas-slot",
    title: "Canvases",
    description: "Every manifest canvas not placed on its own elsewhere in the layout.",
    fields: [],
  },
  {
    type: "markdown",
    title: "Note",
    description: "Markdown text, for notes, instructions or status written by Brad or the agent.",
    fields: [
      {
        key: "text",
        kind: "text",
        label: "Text",
        description: "Markdown, up to 20,000 characters.",
        default: "",
      },
    ],
  },
  {
    type: "links",
    title: "Links",
    description: "A short list of labelled links.",
    fields: [
      {
        key: "items",
        kind: "links",
        label: "Links",
        description: "Up to 30 { label, url } pairs; http(s) only.",
        default: [],
      },
    ],
  },
];

export const ProjectLayoutWidget = Schema.Struct({
  /** Instance id, unique in the layout. */
  id: Schema.String,
  type: Schema.String,
  title: Schema.optionalKey(Schema.String),
  size: Schema.optionalKey(ProjectWidgetSize),
  config: Schema.Record(Schema.String, Schema.Unknown),
});
export type ProjectLayoutWidget = typeof ProjectLayoutWidget.Type;

export const ProjectLayoutTab = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  widgets: Schema.Array(ProjectLayoutWidget),
});
export type ProjectLayoutTab = typeof ProjectLayoutTab.Type;

export const ProjectLayoutActor = Schema.Struct({
  kind: Schema.Literals(["user", "agent", "system"]),
  threadId: Schema.NullOr(ThreadId),
  reason: Schema.NullOr(Schema.String),
});
export type ProjectLayoutActor = typeof ProjectLayoutActor.Type;

export const ProjectLayout = Schema.Struct({
  rootThreadId: ThreadId,
  /** 0 until the first change is saved; increments on every change. */
  revision: NonNegativeInt,
  updatedAt: Schema.NullOr(IsoDateTime),
  updatedBy: Schema.NullOr(ProjectLayoutActor),
  tabs: Schema.Array(ProjectLayoutTab),
});
export type ProjectLayout = typeof ProjectLayout.Type;

const WidgetDraft = Schema.Struct({
  id: Schema.optionalKey(Schema.String),
  type: Schema.String,
  title: Schema.optionalKey(Schema.String),
  size: Schema.optionalKey(ProjectWidgetSize),
  config: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
});

/** One change to a layout; ids address tabs and widgets, so concurrent edits to different things both land. */
export const ProjectLayoutOp = Schema.Union([
  Schema.Struct({
    op: Schema.Literal("addTab"),
    tab: Schema.Struct({ id: Schema.optionalKey(Schema.String), title: Schema.String }),
    index: Schema.optionalKey(NonNegativeInt),
  }),
  Schema.Struct({ op: Schema.Literal("removeTab"), tabId: Schema.String }),
  Schema.Struct({ op: Schema.Literal("renameTab"), tabId: Schema.String, title: Schema.String }),
  Schema.Struct({ op: Schema.Literal("moveTab"), tabId: Schema.String, index: NonNegativeInt }),
  Schema.Struct({
    op: Schema.Literal("addWidget"),
    tabId: Schema.String,
    widget: WidgetDraft,
    index: Schema.optionalKey(NonNegativeInt),
  }),
  Schema.Struct({ op: Schema.Literal("removeWidget"), widgetId: Schema.String }),
  Schema.Struct({
    op: Schema.Literal("moveWidget"),
    widgetId: Schema.String,
    tabId: Schema.String,
    index: NonNegativeInt,
  }),
  Schema.Struct({
    op: Schema.Literal("setWidgetConfig"),
    widgetId: Schema.String,
    /** Keys to set; other keys keep their values. */
    config: Schema.Record(Schema.String, Schema.Unknown),
  }),
  Schema.Struct({
    op: Schema.Literal("setWidgetTitle"),
    widgetId: Schema.String,
    title: Schema.NullOr(Schema.String),
  }),
  Schema.Struct({
    op: Schema.Literal("setWidgetSize"),
    widgetId: Schema.String,
    size: ProjectWidgetSize,
  }),
  Schema.Struct({
    op: Schema.Literal("replaceLayout"),
    tabs: Schema.Array(
      Schema.Struct({
        id: Schema.optionalKey(Schema.String),
        title: Schema.String,
        widgets: Schema.Array(WidgetDraft),
      }),
    ),
  }),
]);
export type ProjectLayoutOp = typeof ProjectLayoutOp.Type;

export const ProjectLayoutGetInput = Schema.Struct({ threadId: ThreadId });
export type ProjectLayoutGetInput = typeof ProjectLayoutGetInput.Type;

export const ProjectLayoutApplyInput = Schema.Struct({
  threadId: ThreadId,
  /** The revision the ops were made against; replaceLayout requires it to be current. */
  baseRevision: NonNegativeInt,
  ops: Schema.Array(ProjectLayoutOp).check(Schema.isMaxLength(100)),
  reason: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(200))),
});
export type ProjectLayoutApplyInput = typeof ProjectLayoutApplyInput.Type;

export const ProjectLayoutRevertInput = Schema.Struct({
  threadId: ThreadId,
  /** Restores the tabs of this revision as a new revision. */
  toRevision: NonNegativeInt,
});
export type ProjectLayoutRevertInput = typeof ProjectLayoutRevertInput.Type;

export const ProjectLayoutHistoryInput = Schema.Struct({
  threadId: ThreadId,
  limit: Schema.optionalKey(NonNegativeInt),
});
export type ProjectLayoutHistoryInput = typeof ProjectLayoutHistoryInput.Type;

export const ProjectLayoutHistoryEntry = Schema.Struct({
  revision: NonNegativeInt,
  updatedAt: Schema.NullOr(IsoDateTime),
  updatedBy: Schema.NullOr(ProjectLayoutActor),
  tabs: Schema.Array(Schema.String),
});
export type ProjectLayoutHistoryEntry = typeof ProjectLayoutHistoryEntry.Type;

export const ProjectLayoutHistory = Schema.Struct({
  entries: Schema.Array(ProjectLayoutHistoryEntry),
});
export type ProjectLayoutHistory = typeof ProjectLayoutHistory.Type;

export class ProjectLayoutError extends Schema.TaggedError<ProjectLayoutError>()(
  "ProjectLayoutError",
  {
    message: Schema.String,
    /** The current layout, when the change conflicted with it. */
    layout: Schema.optionalKey(ProjectLayout),
  },
) {}

// ---------------------------------------------------------------------------
// Pure layout functions, shared by the server and clients (optimistic edits).

const ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

const slug = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 30) || "item";

/** A fresh id for a new tab or widget: the slug of its name, made unique. */
function uniqueId(base: string, taken: ReadonlySet<string>): string {
  const root = slug(base);
  if (!taken.has(root)) return root;
  for (let index = 2; ; index++) {
    const candidate = `${root}-${index}`;
    if (!taken.has(candidate)) return candidate;
  }
}

export const findWidgetType = (type: string) =>
  PROJECT_WIDGET_TYPES.find((candidate) => candidate.type === type);

/**
 * Widgets the project page no longer has (the threads under each workstream replace
 * them). They are not offered or accepted, but layouts saved while they existed
 * still list them, so readers drop them silently instead of failing.
 */
const RETIRED_WIDGET_TYPES: ReadonlySet<string> = new Set(["working", "blocked", "done"]);

/**
 * The tabs without retired widgets: the same array when there are none, so a
 * layout that needs no cleaning keeps its identity.
 */
export function withoutRetiredWidgets(
  tabs: ReadonlyArray<ProjectLayoutTab>,
): ReadonlyArray<ProjectLayoutTab> {
  if (!tabs.some((tab) => tab.widgets.some((widget) => RETIRED_WIDGET_TYPES.has(widget.type)))) {
    return tabs;
  }
  return tabs.map((tab) => ({
    ...tab,
    widgets: tab.widgets.filter((widget) => !RETIRED_WIDGET_TYPES.has(widget.type)),
  }));
}

const isHttpUrl = (value: unknown) => {
  if (typeof value !== "string" || !URL.canParse(value)) return false;
  const protocol = new URL(value).protocol;
  return protocol === "http:" || protocol === "https:";
};

/** Fills defaults and checks every field of a widget's settings; unknown keys are dropped. */
export function normalizeWidgetConfig(
  type: string,
  config: Readonly<Record<string, unknown>>,
): { config: Record<string, unknown> } | { error: string } {
  const definition = findWidgetType(type);
  if (!definition) return { error: `Unknown widget type "${type}".` };
  const result: Record<string, unknown> = {};
  for (const field of definition.fields) {
    const value = config[field.key] ?? field.default;
    if (value === undefined) {
      if (field.required) return { error: `${definition.title} needs ${field.key}.` };
      continue;
    }
    switch (field.kind) {
      case "boolean":
        if (typeof value !== "boolean") return { error: `${field.key} must be true or false.` };
        break;
      case "integer":
        if (
          typeof value !== "number" ||
          !Number.isInteger(value) ||
          (field.min !== undefined && value < field.min) ||
          (field.max !== undefined && value > field.max)
        ) {
          return {
            error: `${field.key} must be a whole number from ${field.min} to ${field.max}.`,
          };
        }
        break;
      case "canvas":
        if (typeof value !== "string" || !/^[a-z0-9][a-z0-9-]{0,29}$/.test(value)) {
          return { error: `${field.key} must be a canvas id from widgets.json.` };
        }
        break;
      case "text":
        if (typeof value !== "string" || value.length > PROJECT_LAYOUT_LIMITS.text) {
          return { error: `${field.key} must be text up to 20,000 characters.` };
        }
        break;
      case "links": {
        const items = value as ReadonlyArray<{ label?: unknown; url?: unknown }>;
        if (
          !Array.isArray(items) ||
          items.length > PROJECT_LAYOUT_LIMITS.links ||
          items.some(
            (item) =>
              typeof item?.label !== "string" ||
              item.label.trim().length === 0 ||
              item.label.length > 120 ||
              !isHttpUrl(item.url),
          )
        ) {
          return { error: `${field.key} must be up to 30 { label, url } with http(s) URLs.` };
        }
        break;
      }
    }
    result[field.key] = value;
  }
  return { config: result };
}

type WidgetDraftValue = typeof WidgetDraft.Type;

function makeWidget(
  draft: WidgetDraftValue,
  taken: Set<string>,
): ProjectLayoutWidget | { error: string } {
  const normalized = normalizeWidgetConfig(draft.type, draft.config ?? {});
  if ("error" in normalized) return normalized;
  const id = draft.id?.trim();
  if (id !== undefined && (!ID_PATTERN.test(id) || id.length > PROJECT_LAYOUT_LIMITS.id)) {
    return { error: `Widget id "${id}" must be lowercase letters, digits and dashes.` };
  }
  if (id !== undefined && taken.has(id)) return { error: `Widget id "${id}" is already used.` };
  const canvasId = normalized.config.canvasId;
  const widgetId =
    id ?? uniqueId(typeof canvasId === "string" ? `canvas-${canvasId}` : draft.type, taken);
  taken.add(widgetId);
  const title = draft.title?.trim();
  if (title !== undefined && title.length > PROJECT_LAYOUT_LIMITS.title) {
    return { error: "Widget titles are at most 60 characters." };
  }
  return {
    id: widgetId,
    type: draft.type,
    ...(title ? { title } : {}),
    ...(draft.size ? { size: draft.size } : {}),
    config: normalized.config,
  };
}

const clampIndex = (index: number | undefined, length: number) =>
  index === undefined ? length : Math.max(0, Math.min(index, length));

function locateWidget(tabs: ReadonlyArray<ProjectLayoutTab>, widgetId: string) {
  for (const [tabIndex, tab] of tabs.entries()) {
    const widgetIndex = tab.widgets.findIndex((widget) => widget.id === widgetId);
    if (widgetIndex >= 0) return { tabIndex, widgetIndex };
  }
  return null;
}

/**
 * Applies ops in order to a layout's tabs. Ops address tabs and widgets by id,
 * so they apply on top of whatever revision is current; an op whose target is
 * gone, or that breaks a limit or a widget's settings, fails the whole batch.
 */
export function applyLayoutOps(
  tabs: ReadonlyArray<ProjectLayoutTab>,
  ops: ReadonlyArray<ProjectLayoutOp>,
): { tabs: ProjectLayoutTab[] } | { error: string } {
  let next = tabs.map((tab) => ({ ...tab, widgets: [...tab.widgets] }));
  const widgetIds = () => new Set(next.flatMap((tab) => tab.widgets.map((widget) => widget.id)));
  const tabAt = (tabId: string) => next.findIndex((tab) => tab.id === tabId);
  for (const op of ops) {
    switch (op.op) {
      case "addTab": {
        if (next.length >= PROJECT_LAYOUT_LIMITS.tabs) return { error: "At most 12 tabs." };
        const title = op.tab.title.trim();
        if (!title || title.length > PROJECT_LAYOUT_LIMITS.title) {
          return { error: "A tab needs a title up to 60 characters." };
        }
        const taken = new Set(next.map((tab) => tab.id));
        const id = op.tab.id?.trim() ?? uniqueId(title, taken);
        if (!ID_PATTERN.test(id) || id.length > PROJECT_LAYOUT_LIMITS.id || taken.has(id)) {
          return { error: `Tab id "${id}" is invalid or already used.` };
        }
        next.splice(clampIndex(op.index, next.length), 0, { id, title, widgets: [] });
        break;
      }
      case "removeTab": {
        const index = tabAt(op.tabId);
        if (index < 0) return { error: `No tab "${op.tabId}".` };
        if (next.length === 1) return { error: "A layout keeps at least one tab." };
        next.splice(index, 1);
        break;
      }
      case "renameTab": {
        const index = tabAt(op.tabId);
        const title = op.title.trim();
        if (index < 0) return { error: `No tab "${op.tabId}".` };
        if (!title || title.length > PROJECT_LAYOUT_LIMITS.title) {
          return { error: "A tab needs a title up to 60 characters." };
        }
        next[index] = { ...next[index]!, title };
        break;
      }
      case "moveTab": {
        const index = tabAt(op.tabId);
        if (index < 0) return { error: `No tab "${op.tabId}".` };
        const [tab] = next.splice(index, 1);
        next.splice(clampIndex(op.index, next.length), 0, tab!);
        break;
      }
      case "addWidget": {
        const index = tabAt(op.tabId);
        if (index < 0) return { error: `No tab "${op.tabId}".` };
        const tab = next[index]!;
        if (tab.widgets.length >= PROJECT_LAYOUT_LIMITS.widgetsPerTab) {
          return { error: "At most 30 widgets per tab." };
        }
        const widget = makeWidget(op.widget, widgetIds());
        if ("error" in widget) return widget;
        tab.widgets.splice(clampIndex(op.index, tab.widgets.length), 0, widget);
        break;
      }
      case "removeWidget": {
        const found = locateWidget(next, op.widgetId);
        if (!found) return { error: `No widget "${op.widgetId}".` };
        next[found.tabIndex]!.widgets.splice(found.widgetIndex, 1);
        break;
      }
      case "moveWidget": {
        const found = locateWidget(next, op.widgetId);
        const target = tabAt(op.tabId);
        if (!found) return { error: `No widget "${op.widgetId}".` };
        if (target < 0) return { error: `No tab "${op.tabId}".` };
        const [widget] = next[found.tabIndex]!.widgets.splice(found.widgetIndex, 1);
        const targetTab = next[target]!;
        if (targetTab.widgets.length >= PROJECT_LAYOUT_LIMITS.widgetsPerTab) {
          return { error: "At most 30 widgets per tab." };
        }
        targetTab.widgets.splice(clampIndex(op.index, targetTab.widgets.length), 0, widget!);
        break;
      }
      case "setWidgetConfig":
      case "setWidgetTitle":
      case "setWidgetSize": {
        const found = locateWidget(next, op.widgetId);
        if (!found) return { error: `No widget "${op.widgetId}".` };
        const widgets = next[found.tabIndex]!.widgets;
        const widget = widgets[found.widgetIndex]!;
        if (op.op === "setWidgetConfig") {
          const normalized = normalizeWidgetConfig(widget.type, { ...widget.config, ...op.config });
          if ("error" in normalized) return normalized;
          widgets[found.widgetIndex] = { ...widget, config: normalized.config };
        } else if (op.op === "setWidgetTitle") {
          const title = op.title?.trim() ?? "";
          if (title.length > PROJECT_LAYOUT_LIMITS.title) {
            return { error: "Widget titles are at most 60 characters." };
          }
          const { title: _previous, ...rest } = widget;
          widgets[found.widgetIndex] = title ? { ...rest, title } : rest;
        } else {
          widgets[found.widgetIndex] = { ...widget, size: op.size };
        }
        break;
      }
      case "replaceLayout": {
        if (op.tabs.length === 0 || op.tabs.length > PROJECT_LAYOUT_LIMITS.tabs) {
          return { error: "A layout has 1 to 12 tabs." };
        }
        const replaced: ProjectLayoutTab[] = [];
        const tabIds = new Set<string>();
        const taken = new Set<string>();
        for (const draft of op.tabs) {
          const title = draft.title.trim();
          if (!title || title.length > PROJECT_LAYOUT_LIMITS.title) {
            return { error: "A tab needs a title up to 60 characters." };
          }
          const id = draft.id?.trim() ?? uniqueId(title, tabIds);
          if (!ID_PATTERN.test(id) || tabIds.has(id)) {
            return { error: `Tab id "${id}" is invalid or already used.` };
          }
          tabIds.add(id);
          if (draft.widgets.length > PROJECT_LAYOUT_LIMITS.widgetsPerTab) {
            return { error: "At most 30 widgets per tab." };
          }
          const widgets: ProjectLayoutWidget[] = [];
          for (const widgetDraft of draft.widgets) {
            const widget = makeWidget(widgetDraft, taken);
            if ("error" in widget) return widget;
            widgets.push(widget);
          }
          replaced.push({ id, title, widgets });
        }
        next = replaced.map((tab) => ({ ...tab, widgets: [...tab.widgets] }));
        break;
      }
    }
  }
  return { tabs: next };
}

/** Today's Dashboard order, used until a project saves its own layout. */
const DEFAULT_DASHBOARD_TYPES = [
  "requests",
  "needs-you",
  "decisions",
  "release",
  "maintenance",
  "roadmap-summary",
  "issues-summary",
  "prs",
  "canvas-slot",
  "automations",
] as const;

/** Widget ids of the older per-project widget order, mapped onto widget types. */
const LEGACY_WIDGET_TYPES: Readonly<Record<string, string>> = {
  requests: "requests",
  "needs-you": "needs-you",
  release: "release",
  maintenance: "maintenance",
  roadmap: "roadmap-summary",
  "new-request": "composer",
  issues: "issues-summary",
  prs: "prs",
  canvas: "canvas-slot",
  automations: "automations",
};

const legacyWidget = (legacyId: string): WidgetDraftValue | null => {
  if (legacyId.startsWith("canvas:")) {
    return { type: "canvas", config: { canvasId: legacyId.slice("canvas:".length) } };
  }
  const type = LEGACY_WIDGET_TYPES[legacyId];
  return type ? { type } : null;
};

/**
 * The layout a project starts with: Dashboard (the saved widget order, or the
 * default one), Roadmap and Issues. Matches the page before layouts existed.
 */
export function defaultProjectLayoutTabs(
  savedWidgetOrder: ReadonlyArray<string> | null,
): ProjectLayoutTab[] {
  const drafts = (savedWidgetOrder ?? DEFAULT_DASHBOARD_TYPES.map((type) => type)).flatMap(
    (legacyId) => {
      const widget = savedWidgetOrder === null ? { type: legacyId } : legacyWidget(legacyId);
      return widget ? [widget] : [];
    },
  );
  const taken = new Set<string>();
  const dashboard = drafts.flatMap((draft) => {
    const widget = makeWidget(draft, taken);
    return "error" in widget ? [] : [widget];
  });
  return [
    { id: "dashboard", title: "Dashboard", widgets: dashboard },
    {
      id: "roadmap",
      title: "Roadmap",
      widgets: [{ id: "roadmap-board", type: "roadmap-board", config: {} }],
    },
    {
      id: "issues",
      title: "Tasks",
      widgets: [{ id: "issues-board", type: "issues-board", config: { pendingPreview: 10 } }],
    },
  ];
}

/** The older widget ids of a layout's first tab, for the CLI's `dashboard show`. */
export function legacyWidgetOrder(tabs: ReadonlyArray<ProjectLayoutTab>): string[] {
  const reverse = new Map(Object.entries(LEGACY_WIDGET_TYPES).map(([id, type]) => [type, id]));
  return (tabs[0]?.widgets ?? []).flatMap((widget) => {
    if (widget.type === "canvas" && typeof widget.config.canvasId === "string") {
      return [`canvas:${widget.config.canvasId}`];
    }
    const id = reverse.get(widget.type);
    return id ? [id] : [];
  });
}

/**
 * A widget id of `dashboard set --widgets`: an older id (`roadmap`), `canvas:<id>`,
 * or any registered widget type (`decisions`, `markdown`, ...). Null when it is none.
 */
function widgetDraftForId(id: string): WidgetDraftValue | null {
  return legacyWidget(id) ?? (findWidgetType(id) ? { type: id } : null);
}

/**
 * Ops that make the first tab show these widget ids, in order (the CLI's
 * `dashboard set`). Ids that name no widget are an error: dropping one silently
 * hid widgets the caller believed it had added.
 */
export function widgetOrderOps(
  tabs: ReadonlyArray<ProjectLayoutTab>,
  requestedOrder: ReadonlyArray<string>,
): { ops: ProjectLayoutOp[] } | { error: string } {
  // A retired id, such as one in an older script, is skipped rather than an error.
  const order = requestedOrder.filter((id) => !RETIRED_WIDGET_TYPES.has(id));
  const unknown = order.filter((id) => widgetDraftForId(id) === null);
  if (unknown.length > 0) {
    return {
      error: `Unknown widget id${unknown.length > 1 ? "s" : ""}: ${unknown.join(", ")}. Use an older id, canvas:<id>, or one of: ${PROJECT_WIDGET_TYPES.map((entry) => entry.type).join(", ")}.`,
    };
  }
  const first = tabs[0];
  if (!first) return { ops: [] };
  const ops: ProjectLayoutOp[] = first.widgets.map((widget) => ({
    op: "removeWidget" as const,
    widgetId: widget.id,
  }));
  const reused = new Set<string>();
  for (const id of order) {
    const draft = widgetDraftForId(id)!;
    const existing = first.widgets.find(
      (widget) =>
        !reused.has(widget.id) &&
        widget.type === draft.type &&
        (draft.type !== "canvas" || widget.config.canvasId === draft.config?.canvasId),
    );
    if (existing) reused.add(existing.id);
    ops.push({
      op: "addWidget",
      tabId: first.id,
      widget: existing
        ? {
            id: existing.id,
            type: existing.type,
            config: existing.config,
            ...(existing.title ? { title: existing.title } : {}),
            ...(existing.size ? { size: existing.size } : {}),
          }
        : draft,
    });
  }
  return { ops };
}
