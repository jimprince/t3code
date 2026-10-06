import { ChevronDownIcon, ChevronRightIcon, MoreHorizontalIcon } from "lucide-react";
import { createContext, use, type ReactNode } from "react";

import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";

/**
 * Whether the widget being rendered is collapsed, provided by the layout host so every
 * widget's header gets the same control. Null where nothing remembers it (the editor).
 */
export interface WidgetCollapse {
  readonly collapsed: boolean;
  readonly toggle: () => void;
}
export const WidgetCollapseContext = createContext<WidgetCollapse | null>(null);

/** The chevron at the start of a widget header; renders nothing outside the layout host. */
export function WidgetCollapseToggle() {
  const collapse = use(WidgetCollapseContext);
  if (!collapse) return null;
  return (
    <Button
      size="icon-xs"
      variant="ghost"
      aria-label={collapse.collapsed ? "Expand" : "Collapse"}
      aria-expanded={!collapse.collapsed}
      onClick={collapse.toggle}
    >
      {collapse.collapsed ? <ChevronRightIcon /> : <ChevronDownIcon />}
    </Button>
  );
}

/** A project-page widget heading: "NEEDS YOU 3", with an optional action at the right. */
function SectionHeading({
  title,
  count,
  action,
}: {
  readonly title: ReactNode;
  readonly count?: number | undefined;
  readonly action?: ReactNode;
}) {
  return (
    <div className="mb-2 flex items-center gap-2">
      <WidgetCollapseToggle />
      <h2 className="flex min-w-0 items-center gap-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
        {title}
        {count === undefined ? null : (
          <span className="tabular-nums text-foreground/60">{count}</span>
        )}
      </h2>
      {action ? <div className="ml-auto">{action}</div> : null}
    </div>
  );
}

/**
 * A widget on the project page: its heading, then its rows. Widgets are spaced by
 * the layout grid, not ruled off, so every widget sits the same way whatever its position.
 */
export function ProjectSection({
  title,
  count,
  action,
  children,
}: {
  readonly title: ReactNode;
  readonly count?: number | undefined;
  readonly action?: ReactNode;
  readonly children: ReactNode;
}) {
  const collapsed = use(WidgetCollapseContext)?.collapsed ?? false;
  return (
    <section>
      <SectionHeading title={title} count={count} action={action} />
      {collapsed ? null : children}
    </section>
  );
}

/** A group inside a widget: "For review 3". */
export const GroupTitle = ({
  title,
  count,
}: {
  readonly title: string;
  readonly count: number;
}) => (
  <h3 className="mb-1 text-xs text-foreground/80">
    {title} <span className="tabular-nums text-muted-foreground">{count}</span>
  </h3>
);

/**
 * The status column of a task row, the same width in every widget. Below `sm` it
 * hides and the row's meta line carries the status instead.
 */
export const StatusCell = ({
  children,
  tone = "muted",
}: {
  readonly children: ReactNode;
  readonly tone?: "muted" | "strong" | "warning";
}) => (
  <span
    className={`hidden w-24 shrink-0 pt-px text-xs sm:block ${
      tone === "strong"
        ? "text-foreground/90"
        : tone === "warning"
          ? "text-warning-foreground"
          : "text-muted-foreground"
    }`}
  >
    {children}
  </span>
);

export interface RowMenuItem {
  readonly label: string;
  readonly onClick: () => void;
  readonly disabled?: boolean;
}

/** Secondary row actions (Settle, Reopen, Move to) behind one "more" button. */
export function RowMenu({
  label,
  items,
}: {
  /** What the menu acts on, for its accessible name. */
  readonly label: string;
  readonly items: ReadonlyArray<RowMenuItem>;
}) {
  if (items.length === 0) return null;
  return (
    <Menu>
      <MenuTrigger
        render={<Button size="icon-xs" variant="ghost" aria-label={`More for ${label}`} />}
      >
        <MoreHorizontalIcon />
      </MenuTrigger>
      <MenuPopup align="end">
        {items.map((item) => (
          <MenuItem key={item.label} disabled={item.disabled} onClick={item.onClick}>
            {item.label}
          </MenuItem>
        ))}
      </MenuPopup>
    </Menu>
  );
}
