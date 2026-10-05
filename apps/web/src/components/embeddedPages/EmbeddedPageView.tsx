import { ExternalLinkIcon } from "lucide-react";

import { usePreviewWebviewConfig } from "~/browser/previewWebviewConfigState";
import { isElectron } from "~/env";
import { isPreviewSupportedInRuntime } from "~/previewStateStore";
import { usePrimaryEnvironmentId } from "~/state/environments";
import type { EnvironmentId } from "@t3tools/contracts";

import { WorkspaceBreadcrumb, WorkspaceBreadcrumbItem } from "../WorkspaceBreadcrumb";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { Button } from "../ui/button";
import { SidebarInset } from "../ui/sidebar";
import { findEmbeddedPage, resolveEmbeddedPageHost } from "./embeddedPages.logic";
import { useEmbeddedPages } from "./useEmbeddedPages";

/**
 * Everything a normal tab allows except navigating T3 Code itself away. Pages
 * are third-party sites that need their own scripts and origin storage (a login
 * session), so `allow-same-origin` is required; the escape it enables only
 * matters for a frame on T3 Code's own origin.
 */
const EMBEDDED_PAGE_FRAME_SANDBOX =
  "allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-downloads allow-modals";

/** Main-area view for one footer page, opened from its sidebar icon. */
export function EmbeddedPageView({ pageId }: { readonly pageId: string }) {
  const page = findEmbeddedPage(useEmbeddedPages(), pageId);
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const host = page
    ? resolveEmbeddedPageHost(page.url, {
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
              render={<a href={page.url} target="_blank" rel="noreferrer" />}
            >
              <ExternalLinkIcon />
              Open in browser
            </Button>
          ) : null}
        </WorkspacePageHeader>
        <div className="relative min-h-0 flex-1 border-t">
          {page === null || host === null ? (
            <p className="p-6 text-sm text-muted-foreground">
              This page was removed. Add it again in Settings → General → Sidebar pages.
            </p>
          ) : host.kind === "blocked" ? (
            <div className="space-y-3 p-6 text-sm">
              <p className="text-muted-foreground">{host.reason}</p>
              <Button size="sm" render={<a href={page.url} target="_blank" rel="noreferrer" />}>
                <ExternalLinkIcon />
                Open in browser
              </Button>
            </div>
          ) : host.kind === "webview" && primaryEnvironmentId !== null ? (
            <EmbeddedPageWebview
              key={page.url}
              environmentId={primaryEnvironmentId}
              url={page.url}
            />
          ) : (
            <iframe
              key={page.url}
              className="absolute inset-0 size-full bg-white"
              src={page.url}
              title={page.name}
              sandbox={EMBEDDED_PAGE_FRAME_SANDBOX}
            />
          )}
        </div>
      </div>
    </SidebarInset>
  );
}

/**
 * A plain Electron guest on the primary environment's default browser profile,
 * the same session the Browser panel uses. The desktop shell only admits
 * guests on browser partitions, so this waits for that partition.
 */
function EmbeddedPageWebview({
  environmentId,
  url,
}: {
  readonly environmentId: EnvironmentId;
  readonly url: string;
}) {
  const config = usePreviewWebviewConfig(environmentId);
  if (config === null) return null;
  return (
    <webview
      className="absolute inset-0 size-full"
      src={url}
      partition={config.partition}
      webpreferences={config.webPreferences}
    />
  );
}
