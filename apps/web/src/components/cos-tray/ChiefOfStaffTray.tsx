import { useNavigate } from "@tanstack/react-router";
import {
  ArrowUpRightIcon,
  ChevronDownIcon,
  ChevronUpIcon,
  Maximize2Icon,
  MinusIcon,
  Minimize2Icon,
  XIcon,
} from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";

import { useIsMobile, useMediaQuery } from "../../hooks/useMediaQuery";
import { cn } from "../../lib/utils";
import { useChiefOfStaff } from "../../state/chiefOfStaff";
import { buildThreadRouteParams } from "../../threadRoutes";
import ChatView from "../ChatView";
import { Button } from "../ui/button";
import { Sheet, SheetPopup } from "../ui/sheet";
import { CosDecisionPin } from "./CosDecisionPin";
import { CosDot, CosSummaryLine } from "./CosStatus";
import {
  COS_TRAY_EXPANDED_WIDTH,
  COS_TRAY_OVERLAY_BELOW,
  COS_TRAY_PEEK_HEIGHT,
  COS_TRAY_RAIL_WIDTH,
  COS_TRAY_WIDTH,
  waitingLabel,
} from "./cosTray.logic";
import { useCosTrayStore } from "./cosTrayStore";

type Cos = NonNullable<ReturnType<typeof useChiefOfStaff>>;

/** Open the full thread, minimize, expand and close: every state has its way back. */
function TrayActions({ cos, expandable }: { readonly cos: Cos; readonly expandable: boolean }) {
  const navigate = useNavigate();
  const { expanded, setMode, toggleExpanded } = useCosTrayStore();
  return (
    <div className="flex shrink-0 items-center">
      <Button
        size="icon-sm"
        variant="ghost"
        aria-label="Open the Chief of Staff thread"
        onClick={() =>
          void navigate({
            to: "/$environmentId/$threadId",
            params: buildThreadRouteParams(cos.ref),
          })
        }
      >
        <ArrowUpRightIcon />
      </Button>
      <Button
        size="icon-sm"
        variant="ghost"
        aria-label="Minimize the Chief of Staff tray"
        onClick={() => setMode("minimized")}
      >
        {expandable ? <MinusIcon /> : <ChevronDownIcon />}
      </Button>
      {expandable ? (
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label={
            expanded ? "Shrink the Chief of Staff tray" : "Expand the Chief of Staff tray"
          }
          onClick={toggleExpanded}
        >
          {expanded ? <Minimize2Icon /> : <Maximize2Icon />}
        </Button>
      ) : null}
      <Button
        size="icon-sm"
        variant="ghost"
        aria-label="Close the Chief of Staff tray"
        onClick={() => setMode("closed")}
      >
        <XIcon />
      </Button>
    </div>
  );
}

function TrayBody({ cos, expandable }: { readonly cos: Cos; readonly expandable: boolean }) {
  const [decisionsOpen, setDecisionsOpen] = useState(true);
  const decisionsId = useId();
  const decisionsToggle = useRef<HTMLButtonElement>(null);
  const hideDecisions = () => {
    setDecisionsOpen(false);
    decisionsToggle.current?.focus();
  };
  return (
    <>
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border pr-1 pl-3">
        <CosDot waiting={cos.waiting} replying={cos.replying} />
        <span className="min-w-0 flex-1 truncate text-sm font-medium">Chief of Staff</span>
        <TrayActions cos={cos} expandable={expandable} />
      </div>
      <div className="shrink-0 border-b border-border px-3 py-1.5">
        <CosSummaryLine
          waiting={cos.waiting}
          lastReplyAt={cos.lastReplyAt}
          decisionsOpen={decisionsOpen}
          decisionsId={decisionsId}
          toggleRef={decisionsToggle}
          onToggleDecisions={() => setDecisionsOpen((open) => !open)}
        />
      </div>
      {cos.waiting > 0 ? (
        <CosDecisionPin
          environmentId={cos.ref.environmentId}
          id={decisionsId}
          open={decisionsOpen}
          onClose={hideDecisions}
        />
      ) : null}
      <ChatView
        routeKind="server"
        environmentId={cos.ref.environmentId}
        threadId={cos.ref.threadId}
        presentation="tray"
      />
    </>
  );
}

function DesktopTray({ cos }: { readonly cos: Cos }) {
  const { mode, expanded, setMode } = useCosTrayStore();
  const overlay = useMediaQuery(`(max-width: ${COS_TRAY_OVERLAY_BELOW - 1}px)`);
  if (mode === "closed") return null;
  if (mode === "minimized") {
    return (
      <button
        type="button"
        data-testid="cos-rail"
        aria-label="Open the Chief of Staff tray"
        style={{ width: COS_TRAY_RAIL_WIDTH }}
        className="flex min-h-0 shrink-0 cursor-pointer flex-col items-center gap-3 border-l border-border bg-sidebar py-3 hover:bg-accent focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70 focus-visible:outline-none"
        onClick={() => setMode("open")}
      >
        <CosDot waiting={cos.waiting} replying={cos.replying} />
        <span className="text-sm font-medium [writing-mode:vertical-rl] rotate-180">
          Chief of Staff
        </span>
        {cos.waiting > 0 ? (
          <span className="text-xs text-warning-foreground">{cos.waiting}</span>
        ) : null}
      </button>
    );
  }
  const width = expanded ? COS_TRAY_EXPANDED_WIDTH : COS_TRAY_WIDTH;
  return (
    <aside
      data-testid="cos-tray"
      aria-label="Chief of Staff"
      style={{ width, maxWidth: "100vw" }}
      className={cn(
        "flex min-h-0 shrink-0 flex-col border-l border-border bg-background",
        overlay &&
          "fixed inset-y-0 top-(--server-restart-banner-height,0px) right-0 z-40 shadow-lg",
      )}
    >
      <TrayBody cos={cos} expandable />
    </aside>
  );
}

/** Reserves the peek bar's height so it never covers the page's composer. */
function usePeekReserve(active: boolean) {
  useEffect(() => {
    if (!active) return;
    const root = document.documentElement;
    root.style.setProperty("--cos-peek-height", `${COS_TRAY_PEEK_HEIGHT}px`);
    return () => {
      root.style.removeProperty("--cos-peek-height");
    };
  }, [active]);
}

function PhoneTray({ cos }: { readonly cos: Cos }) {
  const { mode, phoneSheetOpen, setMode } = useCosTrayStore();
  const peek = mode !== "closed" && !phoneSheetOpen;
  usePeekReserve(peek);
  return (
    <>
      {peek ? (
        <button
          type="button"
          data-testid="cos-peek"
          aria-label="Open the Chief of Staff sheet"
          style={{ minHeight: COS_TRAY_PEEK_HEIGHT, paddingBottom: "env(safe-area-inset-bottom)" }}
          className="fixed inset-x-0 bottom-0 z-30 flex cursor-pointer items-center gap-2 border-t border-border bg-sidebar px-4 text-left"
          onClick={() => setMode("open")}
        >
          <CosDot waiting={cos.waiting} replying={cos.replying} />
          <span className="min-w-0 flex-1 truncate text-sm font-medium">Chief of Staff</span>
          {cos.waiting > 0 ? (
            <span className="shrink-0 text-xs text-warning-foreground">
              {waitingLabel(cos.waiting)}
            </span>
          ) : null}
          <ChevronUpIcon className="size-4 shrink-0 text-muted-foreground" />
        </button>
      ) : null}
      <Sheet
        open={phoneSheetOpen}
        onOpenChange={(open) => (open ? undefined : setMode("minimized"))}
      >
        <SheetPopup side="bottom" showCloseButton={false} className="h-[60dvh]">
          <div aria-hidden className="mx-auto mt-2 h-1 w-9 shrink-0 rounded-full bg-border" />
          <TrayBody cos={cos} expandable={false} />
        </SheetPopup>
      </Sheet>
    </>
  );
}

/**
 * The global Chief of Staff conversation: a right column on desktop (open, minimized rail,
 * closed, expanded), a bottom sheet with a peek bar on a phone. Mounted by the app layout so it
 * survives navigation. Renders nothing until a front desk thread exists.
 */
export function ChiefOfStaffTray() {
  const cos = useChiefOfStaff();
  const isMobile = useIsMobile();
  const setPhone = useCosTrayStore((state) => state.setPhone);
  useEffect(() => setPhone(isMobile), [isMobile, setPhone]);
  if (!cos) return null;
  return isMobile ? <PhoneTray cos={cos} /> : <DesktopTray cos={cos} />;
}
