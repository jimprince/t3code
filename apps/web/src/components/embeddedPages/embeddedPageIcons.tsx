import {
  ActivityIcon,
  BookOpenIcon,
  BotIcon,
  GaugeIcon,
  GlobeIcon,
  KanbanIcon,
  LayoutDashboardIcon,
  ListChecksIcon,
  type LucideIcon,
} from "lucide-react";
import { createElement } from "react";

/** The icons a footer page can pick. Ids are stored in settings; keep them stable. */
export const EMBEDDED_PAGE_ICONS: ReadonlyArray<{
  readonly id: string;
  readonly label: string;
  readonly Icon: LucideIcon;
}> = [
  { id: "globe", label: "Globe", Icon: GlobeIcon },
  { id: "dashboard", label: "Dashboard", Icon: LayoutDashboardIcon },
  { id: "activity", label: "Activity", Icon: ActivityIcon },
  { id: "tasks", label: "Tasks", Icon: ListChecksIcon },
  { id: "board", label: "Board", Icon: KanbanIcon },
  { id: "bot", label: "Bot", Icon: BotIcon },
  { id: "gauge", label: "Gauge", Icon: GaugeIcon },
  { id: "docs", label: "Docs", Icon: BookOpenIcon },
];

export const DEFAULT_EMBEDDED_PAGE_ICON = "globe";

/** Unknown ids (picked on a newer client) draw the default globe. */
function embeddedPageIcon(id: string): LucideIcon {
  return EMBEDDED_PAGE_ICONS.find((icon) => icon.id === id)?.Icon ?? GlobeIcon;
}

/** Draws a page's icon from its stored id. */
export function EmbeddedPageIcon({ icon, className }: { icon: string; className?: string }) {
  return createElement(embeddedPageIcon(icon), className ? { className } : {});
}
