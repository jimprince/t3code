import {
  PROJECT_WIDGET_TYPES,
  ProjectLayoutOp,
  findWidgetType,
  widgetOrderOps,
  type ProjectLayout,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

/** Trimmed, lowercased, de-duplicated ids from a comma-separated `--widgets` value. */
export function parseWidgetIds(value: string): string[] {
  const ids = value
    .split(",")
    .map((id) => id.trim().toLowerCase())
    .filter(Boolean);
  return [...new Set(ids)];
}

/** The ops that make the first tab show these widget ids; throws naming every unknown id. */
export function dashboardSetOps(layout: ProjectLayout, ids: ReadonlyArray<string>) {
  const result = widgetOrderOps(layout.tabs, ids);
  if ("error" in result) throw new Error(result.error);
  return result.ops;
}

/** Every tab with every widget (id, type, size, config), so no widget type is hidden. */
export function describeLayout(layout: ProjectLayout) {
  return {
    revision: layout.revision,
    tabs: layout.tabs.map((tab) => ({
      id: tab.id,
      title: tab.title,
      widgets: tab.widgets.map((widget) => ({
        id: widget.id,
        type: widget.type,
        ...(widget.title ? { title: widget.title } : {}),
        size: widget.size ?? null,
        config: widget.config,
      })),
    })),
  };
}

const decodeOps = Schema.decodeUnknownSync(Schema.Array(ProjectLayoutOp));

/** Parses `--ops` into layout ops; the server validates them again against the current layout. */
export function parseLayoutOps(json: string) {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch (error) {
    throw new Error(`--ops is not valid JSON: ${error instanceof Error ? error.message : error}`);
  }
  if (!Array.isArray(value)) throw new Error("--ops must be a JSON array of layout ops.");
  try {
    return decodeOps(value);
  } catch (error) {
    throw new Error(`--ops has an invalid op: ${error instanceof Error ? error.message : error}`);
  }
}

/** The op for `project layout add`: one widget of a registered type at the end of a tab. */
export function addWidgetOp(type: string, tabId: string): ProjectLayoutOp {
  if (!findWidgetType(type)) {
    throw new Error(
      `Unknown widget type "${type}". Use one of: ${PROJECT_WIDGET_TYPES.map((entry) => entry.type).join(", ")}.`,
    );
  }
  return { op: "addWidget", tabId, widget: { type } };
}
