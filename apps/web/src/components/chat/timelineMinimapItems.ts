import { stripNotifyMarker } from "@t3tools/client-runtime/notify-marker";
import type { MessagesTimelineRow } from "./MessagesTimeline.logic";

export interface TimelineMinimapItem {
  readonly id: string;
  readonly rowIndex: number;
  readonly userText: string | null;
  /** An agent sent this message; a person typed it otherwise. */
  readonly userFromAgent: boolean;
  readonly assistantText: string | null;
}

/** Keep full source text untouched until a minimap preview is opened. */
export function deriveTimelineMinimapItems(
  rows: ReadonlyArray<MessagesTimelineRow>,
): TimelineMinimapItem[] {
  const items: TimelineMinimapItem[] = [];
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    if (row?.kind !== "message" || row.message.role !== "user") {
      continue;
    }

    items.push({
      id: row.id,
      rowIndex: index,
      userText: row.message.text,
      userFromAgent: row.message.createdBy === "agent",
      assistantText: resolveFinalAssistantTextForTurn(rows, index),
    });
  }
  return items;
}

function resolveFinalAssistantTextForTurn(
  rows: ReadonlyArray<MessagesTimelineRow>,
  userRowIndex: number,
) {
  let finalAssistantText: string | null = null;
  for (let index = userRowIndex + 1; index < rows.length; index += 1) {
    const row = rows[index];
    if (row?.kind !== "message") {
      continue;
    }
    if (row.message.role === "user") {
      break;
    }
    if (row.message.role === "assistant") {
      finalAssistantText = row.message.text ?? null;
    }
  }
  return finalAssistantText;
}

function compactMinimapPreview(text: string | null | undefined) {
  const compact = text?.replace(/\s+/g, " ").trim() ?? "";
  return compact.length > 0 ? compact : null;
}

export function resolveTimelineMinimapPreview(
  item: TimelineMinimapItem | null,
): TimelineMinimapItem | null {
  return item === null
    ? null
    : {
        ...item,
        // The T3_NOTIFY routing marker ends agent-sent and assistant text; it is not content.
        userText: compactMinimapPreview(
          item.userText !== null && item.userFromAgent
            ? stripNotifyMarker(item.userText)
            : item.userText,
        ),
        assistantText: compactMinimapPreview(
          item.assistantText === null ? null : stripNotifyMarker(item.assistantText),
        ),
      };
}
