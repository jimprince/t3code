import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  resolveHarnessCheckPage,
  type HarnessCheckPage as HarnessCheckPageView,
  type HarnessCheckRef,
} from "@t3tools/client-runtime/state/harness-check-page";
import type { HarnessTone } from "@t3tools/client-runtime/state/harness-view";
import type { HarnessThreadLink } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { ChevronLeftIcon, PinIcon, PinOffIcon } from "lucide-react";
import { useMemo, type ReactNode } from "react";

import { useNowMinute } from "../../hooks/useNowMinute";
import { isElectron } from "../../env";
import { cn } from "../../lib/utils";
import { useHarnessEnvironments } from "../../state/harness";
import { buildThreadRouteParams } from "../../threadRoutes";
import { useSidebarMode } from "../sidebarMode";
import { Button } from "../ui/button";
import { SidebarInset, useSidebar } from "../ui/sidebar";
import { WorkspacePageContainer } from "../WorkspacePageContainer";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { TONE_DOT } from "./harnessTone";
import { useHarnessCheckPin } from "./useHarnessCheckPin";

const TONE_TEXT: Record<HarnessTone, string> = {
  error: "text-error",
  warning: "text-warning-foreground",
  muted: "text-muted-foreground",
  ok: "text-success-foreground",
};

/** Opens a run's or owner's thread; the link carries its own environment, so remote runs resolve. */
function useOpenThreadLink() {
  const navigate = useNavigate();
  return (link: HarnessThreadLink) =>
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(scopeThreadRef(link.environmentId, link.threadId)),
    });
}

function Section({ title, children }: { readonly title: string; readonly children: ReactNode }) {
  return (
    <section className="flex flex-col gap-1.5">
      <h2 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
        {title}
      </h2>
      {children}
    </section>
  );
}

function CheckBody({ page }: { readonly page: HarnessCheckPageView }) {
  const openThread = useOpenThreadLink();
  const { check, facts, runs } = page;
  return (
    <>
      <div className="flex flex-col gap-1">
        <div className="flex items-center gap-2">
          <span aria-hidden className={cn("size-2 shrink-0 rounded-full", TONE_DOT[check.tone])} />
          <h2 className="min-w-0 flex-1 text-lg font-semibold break-words">{check.name}</h2>
          <span className={cn("shrink-0 text-sm", TONE_TEXT[check.tone])}>
            {check.latenessLabel ?? check.stateLabel}
          </span>
        </div>
        <p className="text-sm text-muted-foreground">
          {[check.classification, page.environmentLabel].filter((part) => part).join(" · ")}
        </p>
        <p className="text-sm break-words">{check.evidence}</p>
        {page.readError !== null ? (
          <p role="alert" className="text-sm text-warning-foreground">
            The server did not answer ({page.readError}); showing the last read,{" "}
            {page.freshness.label}.
          </p>
        ) : null}
      </div>

      {check.whatItChecks ? (
        <Section title="What it checks">
          <p className="text-sm break-words whitespace-pre-wrap">{check.whatItChecks}</p>
        </Section>
      ) : null}

      <Section title="Status">
        <dl className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-1 text-sm">
          {facts.map((fact) => (
            <div key={fact.label} className="contents">
              <dt className="text-muted-foreground">{fact.label}</dt>
              <dd className="min-w-0 break-words">{fact.value}</dd>
            </div>
          ))}
          {check.owner ? (
            <div className="contents">
              <dt className="text-muted-foreground">Owner thread</dt>
              <dd>
                <Button
                  size="xs"
                  variant="link"
                  onClick={() => openThread(check.owner as HarnessThreadLink)}
                >
                  Open
                </Button>
              </dd>
            </div>
          ) : null}
        </dl>
      </Section>

      <Section title="Runs">
        {runs.length === 0 ? (
          <p className="text-sm text-muted-foreground">No runs retained.</p>
        ) : (
          <table aria-label={`Runs of ${check.name}`} className="w-full text-sm tabular-nums">
            <thead>
              <tr className="text-left text-xs text-muted-foreground">
                <th className="py-1 pr-4 font-normal">Time</th>
                <th className="py-1 pr-4 font-normal">Outcome</th>
                <th className="py-1 pr-4 text-right font-normal">Errors</th>
                <th className="py-1 text-right font-normal">
                  <span className="sr-only">Thread</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {runs.map((run) => (
                <tr key={run.key} className="border-t border-border/60">
                  <td className="py-1 pr-4">{run.timeLabel}</td>
                  <td className={cn("py-1 pr-4", run.failed && "text-error")}>
                    {run.outcomeLabel}
                    {run.outcomeLabel === "Completed" ? null : (
                      <span className="block text-xs font-normal break-words text-muted-foreground">
                        {run.evidence}
                      </span>
                    )}
                  </td>
                  <td className="py-1 pr-4 text-right">{run.errorsLabel}</td>
                  <td className="py-1 text-right">
                    {run.thread ? (
                      <Button
                        size="xs"
                        variant="link"
                        aria-label={`Open run of ${check.name} at ${run.timeLabel}`}
                        onClick={() => openThread(run.thread as HarnessThreadLink)}
                      >
                        Open
                      </Button>
                    ) : (
                      <span className="text-muted-foreground">none</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {page.historyNote ? (
          <p className="text-xs break-words text-muted-foreground">{page.historyNote}</p>
        ) : null}
      </Section>
    </>
  );
}

/**
 * One Harness check in the main pane, opened from its row in the Harness list: what it checks,
 * its schedule, state and evidence, and the retained run history with a link to each run's
 * thread. Reads the same snapshot as the list, so it refreshes while mounted and on focus.
 */
export function HarnessCheckPage({ checkRef }: { readonly checkRef: HarnessCheckRef }) {
  const { environments, refresh } = useHarnessEnvironments();
  const nowMinute = useNowMinute();
  const now = useMemo(() => Date.parse(`${nowMinute}:00Z`), [nowMinute]);
  const [, setSidebarMode] = useSidebarMode();
  const { setPinned, pinLabel } = useHarnessCheckPin();
  const { isMobile, open, setOpen, setOpenMobile } = useSidebar();
  const state = useMemo(
    () => resolveHarnessCheckPage(environments, checkRef, now),
    [checkRef, environments, now],
  );
  const page = state.kind === "found" ? state.page : null;
  // The list lives in the sidebar: back shows it in the Harness tab, as a drawer on a phone.
  const showList = () => {
    setSidebarMode("harness");
    if (isMobile) setOpenMobile(true);
    else if (!open) setOpen(true);
  };

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden">
      <div className="flex min-h-0 flex-1 flex-col">
        <WorkspacePageHeader electron={isElectron} className="bg-background">
          <Button
            size="xs"
            variant="ghost-muted"
            aria-label="Back to the Harness list"
            onClick={showList}
          >
            <ChevronLeftIcon aria-hidden />
            Harness
          </Button>
          <h1 className="min-w-0 flex-1 truncate text-sm font-medium">
            {page ? page.check.name : "Check"}
          </h1>
          {page?.check.pinSupported ? (
            <Button
              size="xs"
              variant="ghost-muted"
              aria-pressed={page.check.pinned}
              onClick={() => void setPinned(page.check, !page.check.pinned)}
            >
              {page.check.pinned ? <PinOffIcon aria-hidden /> : <PinIcon aria-hidden />}
              {pinLabel(page.check)}
            </Button>
          ) : null}
          {page ? (
            <button
              type="button"
              aria-label="Read the checks again"
              className={cn(
                "shrink-0 cursor-pointer text-xs hover:underline",
                page.freshness.stale ? "text-warning-foreground" : "text-muted-foreground",
              )}
              onClick={refresh}
            >
              {page.freshness.stale ? `stale, ${page.freshness.label}` : page.freshness.label}
            </button>
          ) : null}
        </WorkspacePageHeader>
        <div className="topbar-scroll-fade min-h-0 min-w-0 flex-1 overflow-y-auto border-t border-border">
          <WorkspacePageContainer width="readable" className="gap-5">
            {page ? (
              <CheckBody page={page} />
            ) : state.kind === "not-found" ? (
              <div className="flex flex-col items-start gap-2 text-sm text-muted-foreground">
                <p>{state.message}</p>
                <Button size="xs" variant="outline" onClick={showList}>
                  Back to Harness
                </Button>
              </div>
            ) : state.kind === "error" ? (
              <div role="alert" className="flex items-start gap-2 text-sm text-muted-foreground">
                <p className="min-w-0 flex-1 break-words">{state.message}</p>
                <Button size="xs" variant="outline" onClick={refresh}>
                  Retry
                </Button>
              </div>
            ) : (
              <p role="status" className="text-sm text-muted-foreground">
                Loading the check...
              </p>
            )}
          </WorkspacePageContainer>
        </div>
      </div>
    </SidebarInset>
  );
}
