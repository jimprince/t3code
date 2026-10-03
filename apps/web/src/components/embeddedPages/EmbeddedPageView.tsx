import { BotIcon, ExternalLinkIcon } from "lucide-react";
import { useState } from "react";

import { BrowserSurfaceSlot } from "~/browser/BrowserSurfaceSlot";
import { isElectron } from "~/env";
import { isPreviewSupportedInRuntime } from "~/previewStateStore";
import { usePrimaryEnvironmentId } from "~/state/environments";
import type { EmbeddedPage, EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";

import { WorkspaceBreadcrumb, WorkspaceBreadcrumbItem } from "../WorkspaceBreadcrumb";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { Button } from "../ui/button";
import { SidebarInset } from "../ui/sidebar";
import {
  findEmbeddedPage,
  resolveEmbeddedPageHost,
  statusBoardIssueUrl,
} from "./embeddedPages.logic";
import { PageAgentTray } from "./PageAgentTray";
import { useEmbeddedPages } from "./useEmbeddedPages";
import {
  usePageAgentBrowserTab,
  usePageAgentClosedTrayGuard,
  usePageAgentConversations,
  usePageAgentDiscard,
} from "./usePageAgent";

/**
 * Everything a normal tab allows except navigating T3 Code itself away. Pages
 * are third-party sites that need their own scripts and origin storage (a login
 * session), so `allow-same-origin` is required; the escape it enables only
 * matters for a frame on T3 Code's own origin.
 */
const EMBEDDED_PAGE_FRAME_SANDBOX =
  "allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-downloads allow-modals";

/** Main-area view for one footer page, opened from its sidebar icon. */
export function EmbeddedPageView({
  pageId,
  issueTarget,
}: {
  readonly pageId: string;
  readonly issueTarget?: { readonly repo?: string; readonly issue?: string };
}) {
  const page = findEmbeddedPage(useEmbeddedPages(), pageId);
  const targetUrl =
    page && issueTarget?.repo && issueTarget.issue
      ? statusBoardIssueUrl(page.url, issueTarget.repo, issueTarget.issue)
      : page?.url;
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  return page !== null && primaryEnvironmentId !== null ? (
    <EmbeddedPageWithAgent
      key={`${primaryEnvironmentId}:${page.id}`}
      page={page}
      targetUrl={targetUrl}
      environmentId={primaryEnvironmentId}
    />
  ) : (
    <EmbeddedPageLayout
      page={page}
      targetUrl={targetUrl}
      environmentId={primaryEnvironmentId}
      agent={null}
    />
  );
}

/** A page with its tray agent, which lives on the primary environment. */
function EmbeddedPageWithAgent(props: {
  readonly page: EmbeddedPage;
  readonly targetUrl: string | undefined;
  readonly environmentId: EnvironmentId;
}) {
  const { page, targetUrl, environmentId } = props;
  const { stored, setStored, threadRef, pendingDeletes, discard, settleDiscard } =
    usePageAgentConversations(environmentId, page.id);
  const [trayOpen, setTrayOpen] = useState(false);
  if (stored === null || threadRef === null) return null;
  return (
    <>
      {pendingDeletes.map((threadId) => (
        <PageAgentDiscard
          key={threadId}
          environmentId={environmentId}
          threadId={threadId}
          onSettled={settleDiscard}
        />
      ))}
      <PageAgentClosedTrayGuard
        threadRef={threadRef}
        enabled={!trayOpen && stored.lastSentAt !== null}
      />
      <EmbeddedPageLayout
        page={page}
        targetUrl={targetUrl}
        environmentId={environmentId}
        agent={{
          threadRef,
          trayOpen,
          onToggleTray: () => setTrayOpen((open) => !open),
          tray: trayOpen ? (
            <PageAgentTray
              key={threadRef.threadId}
              page={page}
              environmentId={environmentId}
              threadRef={threadRef}
              conversations={stored}
              onConversationsChange={setStored}
              onDiscard={discard}
              pageActionsAvailable={isPreviewSupportedInRuntime()}
              onClose={() => setTrayOpen(false)}
            />
          ) : null,
        }}
      />
    </>
  );
}

function PageAgentDiscard(props: Parameters<typeof usePageAgentDiscard>[0]) {
  usePageAgentDiscard(props);
  return null;
}

function PageAgentClosedTrayGuard(props: Parameters<typeof usePageAgentClosedTrayGuard>[0]) {
  usePageAgentClosedTrayGuard(props);
  return null;
}

function EmbeddedPageLayout({
  page,
  targetUrl,
  environmentId: primaryEnvironmentId,
  agent,
}: {
  readonly page: EmbeddedPage | null;
  readonly targetUrl: string | undefined;
  readonly environmentId: EnvironmentId | null;
  readonly agent: {
    readonly threadRef: ScopedThreadRef;
    readonly trayOpen: boolean;
    readonly onToggleTray: () => void;
    /** Desktop drives the page; a browser frame on web cannot be operated. */
    readonly tray: React.ReactNode;
  } | null;
}) {
  const effectiveUrl = targetUrl ?? page?.url;
  const host = effectiveUrl
    ? resolveEmbeddedPageHost(effectiveUrl, {
        desktopWebview: isPreviewSupportedInRuntime() && primaryEnvironmentId !== null,
        appProtocol: window.location.protocol,
      })
    : null;

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none isolate">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground">
        <WorkspacePageHeader electron={isElectron}>
          <WorkspaceBreadcrumb ariaLabel="Page breadcrumb" className="min-w-0 flex-1">
            <WorkspaceBreadcrumbItem current>
              <h1 className="truncate">{page?.name ?? "Page not found"}</h1>
            </WorkspaceBreadcrumbItem>
          </WorkspaceBreadcrumb>
          {page ? (
            <Button
              size="xs"
              variant="outline"
              render={<a href={effectiveUrl} target="_blank" rel="noreferrer" />}
            >
              <ExternalLinkIcon />
              Open in browser
            </Button>
          ) : null}
          {agent ? (
            <Button
              size="xs"
              variant={agent.trayOpen ? "secondary" : "outline"}
              aria-pressed={agent.trayOpen}
              onClick={agent.onToggleTray}
            >
              <BotIcon />
              Agent
            </Button>
          ) : null}
        </WorkspacePageHeader>
        <div className="flex min-h-0 flex-1 border-t">
          <div className="relative min-h-0 min-w-0 flex-1">
            {page === null || host === null || effectiveUrl === undefined ? (
              <p className="p-6 text-sm text-muted-foreground">
                This page was removed. Add it again in Settings → General → Sidebar pages.
              </p>
            ) : host.kind === "blocked" ? (
              <div className="space-y-3 p-6 text-sm">
                <p className="text-muted-foreground">{host.reason}</p>
                <Button
                  size="sm"
                  render={<a href={effectiveUrl} target="_blank" rel="noreferrer" />}
                >
                  <ExternalLinkIcon />
                  Open in browser
                </Button>
              </div>
            ) : host.kind === "webview" && agent !== null ? (
              <EmbeddedPageBrowserTab
                threadRef={agent.threadRef}
                pageId={page.id}
                url={effectiveUrl}
              />
            ) : (
              <iframe
                key={effectiveUrl}
                className="absolute inset-0 size-full bg-white"
                src={effectiveUrl}
                title={page.name}
                sandbox={EMBEDDED_PAGE_FRAME_SANDBOX}
              />
            )}
          </div>
          {agent?.tray}
        </div>
      </div>
    </SidebarInset>
  );
}

/**
 * The page as the tray conversation's browser tab, on the default browser
 * profile the Browser panel uses, so its sign-ins carry over and the agent's
 * preview tools drive what the user sees.
 */
function EmbeddedPageBrowserTab(props: {
  readonly threadRef: ScopedThreadRef;
  readonly pageId: string;
  readonly url: string;
}) {
  const runtimeTabId = usePageAgentBrowserTab(props);
  return runtimeTabId === null ? null : (
    <BrowserSurfaceSlot
      key={runtimeTabId}
      tabId={runtimeTabId}
      visible
      className="absolute inset-0 size-full"
    />
  );
}
