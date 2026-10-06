import type { OrchestratorSummary } from "@t3tools/client-runtime/state/orchestrators";
import {
  findWidgetType,
  PROJECT_WIDGET_TYPES,
  type ProjectCanvasPage,
  type ProjectLayoutOp,
  type ProjectLayoutTab,
  type ProjectLayoutWidget,
  type ProjectWidgetConfigField,
  type ProjectWidgetSize,
} from "@t3tools/contracts";
import { GripVerticalIcon, PlusIcon, SettingsIcon, XIcon } from "lucide-react";
import { useMemo, useState, type DragEvent, type ReactNode } from "react";

import ChatMarkdown from "../ChatMarkdown";
import { projectCanvasQuery } from "../../state/projectCanvas";
import { useEnvironmentQuery } from "../../state/query";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Textarea } from "../ui/textarea";
import { ProjectCanvasError, ProjectCanvasWidget } from "./ProjectCanvasWidget";
import { ProjectSection } from "./ProjectSection";

/** Drag payloads: a widget moves within or across tabs, a tab moves along the tab row. */
export const WIDGET_DRAG_TYPE = "application/x-t3-layout-widget";
export const TAB_DRAG_TYPE = "application/x-t3-layout-tab";

const SPAN: Record<ProjectWidgetSize, string> = {
  small: "col-span-6 md:col-span-2",
  medium: "col-span-6 md:col-span-3",
  full: "col-span-6",
};

const SIZE_LABEL: Record<ProjectWidgetSize, string> = {
  small: "Third",
  medium: "Half",
  full: "Full",
};

/** A compact dropdown for the layout editor; `items` maps each value to its label. */
function EditorSelect<T extends string>({
  label,
  value,
  items,
  placeholder,
  onChange,
}: {
  readonly label: string;
  readonly value: T | "";
  readonly items: Readonly<Record<T, string>>;
  readonly placeholder?: string;
  readonly onChange: (value: T) => void;
}) {
  return (
    <Select
      value={value === "" ? null : value}
      items={items}
      onValueChange={(next) => {
        if (next !== null) onChange(next as T);
      }}
    >
      <SelectTrigger size="compact" aria-label={label} className="w-auto">
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectPopup>
        {(Object.keys(items) as T[]).map((key) => (
          <SelectItem key={key} value={key}>
            {items[key]}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}

const widgetLabel = (widget: ProjectLayoutWidget) =>
  widget.title ??
  (widget.type === "canvas" ? `Canvas ${String(widget.config.canvasId ?? "")}` : undefined) ??
  findWidgetType(widget.type)?.title ??
  widget.type;

/** The orchestrator's canvas pages by id, and the ones no canvas widget places. */
function useCanvases(summary: OrchestratorSummary, tabs: ReadonlyArray<ProjectLayoutTab>) {
  const canvas = useEnvironmentQuery(
    projectCanvasQuery({
      environmentId: summary.root.environmentId,
      input: { threadId: summary.root.id },
    }),
  );
  return useMemo(() => {
    const pages = new Map<string, ProjectCanvasPage>(
      (canvas.data?.canvases ?? []).map((page) => [page.id, page]),
    );
    const placed = new Set(
      tabs.flatMap((tab) =>
        tab.widgets
          .filter((widget) => widget.type === "canvas")
          .map((widget) => String(widget.config.canvasId)),
      ),
    );
    return {
      data: canvas.data,
      pages,
      unplaced: [...pages.values()].filter((page) => !placed.has(page.id)),
      now: canvas.dataUpdatedAt ?? 0,
    };
  }, [canvas.data, canvas.dataUpdatedAt, tabs]);
}

function LinksWidget({ widget }: { readonly widget: ProjectLayoutWidget }) {
  const items = (widget.config.items ?? []) as ReadonlyArray<{ label: string; url: string }>;
  if (items.length === 0) return null;
  return (
    <ProjectSection title={widget.title ?? "Links"}>
      <ul className="flex flex-col gap-1">
        {items.map((item) => (
          <li key={`${item.label}:${item.url}`}>
            <a
              href={item.url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-sm hover:underline"
            >
              {item.label}
            </a>
          </li>
        ))}
      </ul>
    </ProjectSection>
  );
}

function NoteWidget({
  summary,
  widget,
}: {
  readonly summary: OrchestratorSummary;
  readonly widget: ProjectLayoutWidget;
}) {
  const text = String(widget.config.text ?? "").trim();
  if (!text) return null;
  const note = (
    <ChatMarkdown
      text={text}
      cwd={undefined}
      environmentId={summary.root.environmentId}
      className="text-sm"
    />
  );
  return widget.title ? <ProjectSection title={widget.title}>{note}</ProjectSection> : note;
}

/** One settings field of a widget in the editor. */
function ConfigField({
  field,
  value,
  canvasNames,
  onChange,
}: {
  readonly field: ProjectWidgetConfigField;
  readonly value: unknown;
  readonly canvasNames: Readonly<Record<string, string>>;
  readonly onChange: (value: unknown) => void;
}) {
  const [draft, setDraft] = useState(() =>
    field.kind === "links"
      ? ((value ?? []) as ReadonlyArray<{ label: string; url: string }>)
          .map((item) => `${item.label} | ${item.url}`)
          .join("\n")
      : String(value ?? ""),
  );
  switch (field.kind) {
    case "boolean":
      return (
        <label className="flex items-center gap-2 text-xs">
          <Checkbox
            checked={value === true}
            onCheckedChange={(checked) => onChange(checked === true)}
          />
          {field.label}
        </label>
      );
    case "integer":
      return (
        <label className="flex items-center gap-2 text-xs">
          {field.label}
          <Input
            type="number"
            className="w-20"
            value={draft}
            min={field.min}
            max={field.max}
            onChange={(event) => setDraft(event.target.value)}
            onBlur={() => onChange(Number(draft))}
          />
        </label>
      );
    case "canvas":
      return (
        <label className="flex items-center gap-2 text-xs">
          {field.label}
          <EditorSelect
            label={field.label}
            value={String(value ?? "")}
            items={canvasNames}
            onChange={onChange}
          />
        </label>
      );
    case "text":
    case "links":
      return (
        <label className="flex flex-col gap-1 text-xs">
          {field.kind === "links" ? `${field.label} (one per line: label | url)` : field.label}
          <Textarea
            rows={field.kind === "links" ? 3 : 5}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onBlur={() =>
              onChange(
                field.kind === "links"
                  ? draft
                      .split("\n")
                      .map((line) => line.split("|").map((part) => part.trim()))
                      .filter(([label, url]) => label && url)
                      .map(([label, url]) => ({ label, url }))
                  : draft,
              )
            }
          />
        </label>
      );
  }
}

/** A widget in edit mode: drag handle, name, size, settings and remove, above its content. */
function EditFrame({
  widget,
  tabId,
  index,
  canvasNames,
  onApply,
  children,
}: {
  readonly widget: ProjectLayoutWidget;
  readonly tabId: string;
  readonly index: number;
  readonly canvasNames: Readonly<Record<string, string>>;
  readonly onApply: (ops: ProjectLayoutOp[]) => void;
  readonly children: ReactNode;
}) {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [over, setOver] = useState(false);
  const fields = findWidgetType(widget.type)?.fields ?? [];
  return (
    <div
      draggable
      onDragStart={(event) => {
        event.dataTransfer.setData(WIDGET_DRAG_TYPE, widget.id);
        event.dataTransfer.effectAllowed = "move";
      }}
      onDragOver={(event: DragEvent) => {
        if (!event.dataTransfer.types.includes(WIDGET_DRAG_TYPE)) return;
        event.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(event: DragEvent) => {
        event.preventDefault();
        setOver(false);
        const moved = event.dataTransfer.getData(WIDGET_DRAG_TYPE);
        if (moved && moved !== widget.id) {
          onApply([{ op: "moveWidget", widgetId: moved, tabId, index }]);
        }
      }}
      className={`rounded-md border border-dashed px-2 pt-1 pb-2 ${over ? "border-foreground/60" : "border-border"}`}
    >
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <GripVerticalIcon className="size-3.5 cursor-grab" aria-hidden />
        <span className="min-w-0 flex-1 truncate font-medium text-foreground/80">
          {widgetLabel(widget)}
        </span>
        <EditorSelect
          label={`Size of ${widgetLabel(widget)}`}
          value={widget.size ?? "full"}
          items={SIZE_LABEL}
          onChange={(size) => onApply([{ op: "setWidgetSize", widgetId: widget.id, size }])}
        />
        {fields.length > 0 ? (
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label={`Settings of ${widgetLabel(widget)}`}
            aria-expanded={settingsOpen}
            onClick={() => setSettingsOpen((open) => !open)}
          >
            <SettingsIcon />
          </Button>
        ) : null}
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label={`Remove ${widgetLabel(widget)}`}
          onClick={() => onApply([{ op: "removeWidget", widgetId: widget.id }])}
        >
          <XIcon />
        </Button>
      </div>
      {settingsOpen ? (
        <div className="mt-2 flex flex-col gap-2 border-t border-border/60 pt-2">
          <label className="flex items-center gap-2 text-xs">
            Title
            <Input
              defaultValue={widget.title ?? ""}
              placeholder={findWidgetType(widget.type)?.title}
              onBlur={(event) =>
                onApply([
                  {
                    op: "setWidgetTitle",
                    widgetId: widget.id,
                    title: event.target.value.trim() || null,
                  },
                ])
              }
            />
          </label>
          {fields.map((field) => (
            <ConfigField
              key={field.key}
              field={field}
              value={widget.config[field.key]}
              canvasNames={canvasNames}
              onChange={(value) =>
                onApply([
                  { op: "setWidgetConfig", widgetId: widget.id, config: { [field.key]: value } },
                ])
              }
            />
          ))}
        </div>
      ) : null}
      <div className="pointer-events-none mt-1 opacity-80">{children}</div>
    </div>
  );
}

/** Adds a widget of any registered type to the open tab. */
function AddWidget({
  tabId,
  canvasNames,
  onApply,
}: {
  readonly tabId: string;
  readonly canvasNames: Readonly<Record<string, string>>;
  readonly onApply: (ops: ProjectLayoutOp[]) => void;
}) {
  const [type, setType] = useState("");
  const [canvasId, setCanvasId] = useState("");
  const definition = findWidgetType(type);
  const needsCanvas = type === "canvas";
  return (
    <div className="col-span-6 flex flex-wrap items-center gap-2 rounded-md border border-dashed border-border px-2 py-2 text-xs">
      <PlusIcon className="size-3.5 text-muted-foreground" aria-hidden />
      <EditorSelect
        label="Widget to add"
        value={type}
        placeholder="Add a widget"
        items={Object.fromEntries(
          PROJECT_WIDGET_TYPES.filter(
            (item) => item.type !== "canvas" || Object.keys(canvasNames).length > 0,
          ).map((item) => [item.type, item.title]),
        )}
        onChange={setType}
      />
      {needsCanvas ? (
        <EditorSelect
          label="Canvas"
          value={canvasId}
          placeholder="Canvas"
          items={canvasNames}
          onChange={setCanvasId}
        />
      ) : null}
      {definition ? (
        <span className="min-w-0 flex-1 truncate text-muted-foreground">
          {definition.description}
        </span>
      ) : null}
      <Button
        size="xs"
        disabled={!definition || (needsCanvas && !canvasId)}
        onClick={() => {
          onApply([
            {
              op: "addWidget",
              tabId,
              widget: { type, ...(needsCanvas ? { config: { canvasId } } : {}) },
            },
          ]);
          setType("");
          setCanvasId("");
        }}
      >
        Add
      </Button>
    </div>
  );
}

/**
 * One tab of the project layout: its widgets in a grid (full, half or a third of
 * the width). In edit mode each widget can be dragged, resized, configured or
 * removed, and new widgets added; every change is one layout op.
 */
export function ProjectLayoutTabView({
  summary,
  tabs,
  tab,
  editing,
  builtins,
  onApply,
}: {
  readonly summary: OrchestratorSummary;
  readonly tabs: ReadonlyArray<ProjectLayoutTab>;
  readonly tab: ProjectLayoutTab;
  readonly editing: boolean;
  /** Built-in widgets rendered by the page, by widget id; this view renders the rest. */
  readonly builtins: ReadonlyMap<string, ReactNode>;
  readonly onApply: (ops: ProjectLayoutOp[]) => void;
}) {
  const canvases = useCanvases(summary, tabs);
  const canvasNames = Object.fromEntries(
    [...canvases.pages.values()].map((page) => [page.id, page.title]),
  );

  const content = (widget: ProjectLayoutWidget): ReactNode => {
    switch (widget.type) {
      case "markdown":
        return <NoteWidget summary={summary} widget={widget} />;
      case "links":
        return <LinksWidget widget={widget} />;
      case "canvas": {
        const page = canvases.pages.get(String(widget.config.canvasId));
        return page ? (
          <ProjectCanvasWidget summary={summary} canvas={page} now={canvases.now} />
        ) : null;
      }
      case "canvas-slot":
        return (
          <>
            {canvases.data ? <ProjectCanvasError canvas={canvases.data} /> : null}
            {canvases.unplaced.length > 0 ? (
              <div className="grid grid-cols-6 gap-4">
                {canvases.unplaced.map((page) => (
                  <ProjectCanvasWidget
                    key={page.id}
                    summary={summary}
                    canvas={page}
                    now={canvases.now}
                  />
                ))}
              </div>
            ) : null}
          </>
        );
      default:
        return builtins.get(widget.id) ?? null;
    }
  };

  const sizeOf = (widget: ProjectLayoutWidget): ProjectWidgetSize =>
    widget.size ??
    (widget.type === "canvas"
      ? (canvases.pages.get(String(widget.config.canvasId))?.size ?? "full")
      : "full");

  return (
    <div className="grid grid-cols-6 gap-x-4 gap-y-8">
      {tab.widgets.map((widget, index) =>
        editing ? (
          <div key={widget.id} className={SPAN[sizeOf(widget)]}>
            <EditFrame
              widget={widget}
              tabId={tab.id}
              index={index}
              canvasNames={canvasNames}
              onApply={onApply}
            >
              {content(widget)}
            </EditFrame>
          </div>
        ) : (
          // A widget with nothing to show renders nothing, and its cell collapses.
          <div key={widget.id} className={`${SPAN[sizeOf(widget)]} min-w-0 empty:hidden`}>
            {content(widget)}
          </div>
        ),
      )}
      {editing ? (
        <>
          <div
            className="col-span-6 rounded-md border border-dashed border-border px-2 py-3 text-center text-xs text-muted-foreground"
            onDragOver={(event) => {
              if (event.dataTransfer.types.includes(WIDGET_DRAG_TYPE)) event.preventDefault();
            }}
            onDrop={(event) => {
              event.preventDefault();
              const moved = event.dataTransfer.getData(WIDGET_DRAG_TYPE);
              if (moved) {
                onApply([
                  { op: "moveWidget", widgetId: moved, tabId: tab.id, index: tab.widgets.length },
                ]);
              }
            }}
          >
            Drop a widget here
          </div>
          <AddWidget tabId={tab.id} canvasNames={canvasNames} onApply={onApply} />
        </>
      ) : null}
    </div>
  );
}
