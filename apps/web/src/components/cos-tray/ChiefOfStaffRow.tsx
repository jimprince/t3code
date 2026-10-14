import { useChiefOfStaff } from "../../state/chiefOfStaff";
import { cn } from "../../lib/utils";
import { useSidebar } from "../ui/sidebar";
import { CosDot } from "./CosStatus";
import { formatLastReply, waitingLabel } from "./cosTray.logic";
import { useCosTrayStore } from "./cosTrayStore";

/**
 * The pinned Chief of Staff row above the sidebar tabs' content, on every tab. One amber count,
 * the newest reply time, and a click that opens or closes the global tray. Hidden until a front
 * desk thread exists.
 */
export function ChiefOfStaffRow() {
  const cos = useChiefOfStaff();
  const toggle = useCosTrayStore((state) => state.toggle);
  const { isMobile, setOpenMobile } = useSidebar();
  if (!cos) return null;
  const lastReply = cos.lastReplyAt ? formatLastReply(cos.lastReplyAt) : "";
  return (
    <button
      type="button"
      data-testid="cos-row"
      className="mb-1 flex w-full cursor-pointer flex-col gap-0.5 rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70 focus-visible:outline-none"
      onClick={() => {
        toggle();
        // The phone drawer covers the page the sheet opens over.
        if (isMobile) setOpenMobile(false);
      }}
    >
      <span className="flex items-center gap-2">
        <CosDot waiting={cos.waiting} replying={cos.replying} />
        <span className="min-w-0 flex-1 truncate font-medium text-sidebar-foreground">
          Chief of Staff
        </span>
        {cos.waiting > 0 ? (
          <span className="shrink-0 text-xs text-warning-foreground">
            {waitingLabel(cos.waiting)}
          </span>
        ) : null}
      </span>
      {lastReply ? (
        <span className={cn("pl-4 text-xs text-sidebar-muted-foreground")}>
          last reply {lastReply}
        </span>
      ) : null}
    </button>
  );
}
