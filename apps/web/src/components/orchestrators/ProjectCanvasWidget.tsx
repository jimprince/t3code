import type { OrchestratorSummary } from "@t3tools/client-runtime/state/orchestrators";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { ProjectCanvas, ProjectCanvasPage } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { usePrimarySettings } from "../../hooks/useSettings";
import { logProjectCanvasAction } from "../../state/projectCanvas";
import { useAtomCommand } from "../../state/use-atom-command";
import { buildThreadRouteParams } from "../../threadRoutes";
import { Button } from "../ui/button";
import { ProjectSection } from "./ProjectSection";
import { formatIssueAge } from "./projectIssuesBoard.logic";
import { useProjectRequests } from "./ProjectRequestsSection";
import {
  allowedIssueUrl,
  allowedUrl,
  canvasHeightKey,
  CANVAS_RESULT_TYPE,
  hostsOf,
  parseCanvasMessage,
  readStoredCanvasHeight,
  RESIZE_RATE_LIMIT,
  takeRateSlot,
} from "./projectCanvasBridge.logic";
import { sendToOrchestrator } from "./sendToOrchestrator";

const FRAME_HEIGHT: Record<ProjectCanvasPage["size"], string> = {
  small: "h-[220px]",
  medium: "h-[320px]",
  full: "h-[420px]",
};

/** Grid span on the project page: a third, half, or the full width (stacked when narrow). */
const CANVAS_SPAN: Record<ProjectCanvasPage["size"], string> = {
  small: "col-span-6 md:col-span-2",
  medium: "col-span-6 md:col-span-3",
  full: "col-span-6",
};

/**
 * The frame height a canvas chose with the resize intent, kept per device so a
 * collapsed page stays collapsed after a reload. Null until one is set, which
 * leaves the size preset in charge.
 */
function useCanvasHeight(summary: OrchestratorSummary, canvasId: string) {
  const key = canvasHeightKey(summary.root.environmentId, summary.root.id, canvasId);
  const [height, setHeight] = useState<number | null>(() => {
    try {
      return readStoredCanvasHeight(window.localStorage.getItem(key));
    } catch {
      return null;
    }
  });
  const apply = useCallback(
    (next: number) => {
      setHeight(next);
      try {
        window.localStorage.setItem(key, String(next));
      } catch {
        // Storage unavailable or full: the height still applies for this visit.
      }
    },
    [key],
  );
  return { height, apply };
}

/** Hosts a canvas may open: GitHub, the configured Gitea web origins, and the tree's links. */
function useKnownHosts(summary: OrchestratorSummary): ReadonlySet<string> {
  const giteaOrigins = usePrimarySettings((settings) =>
    settings.giteaInstances.map((instance) => instance.webOrigin),
  );
  const { query } = useProjectRequests(summary);
  return useMemo(
    () =>
      hostsOf([
        "https://github.com",
        ...giteaOrigins,
        ...(query.data?.issues ?? []).map((issue) => issue.url),
        ...[summary.root, ...summary.descendants].flatMap((thread) =>
          thread.pullRequests.map((link) => link.url),
        ),
      ]),
    [giteaOrigins, query.data, summary.descendants, summary.root],
  );
}

/**
 * The action bridge for one canvas frame. Only messages from this frame's own
 * window with the sandbox's opaque origin count; the intent must be on the
 * whitelist, each frame gets a few intents per 10 seconds, every outcome is
 * logged on the server, and a send waits for Brad to confirm the exact text.
 * Resizes are the exception: they are cosmetic, so they have a separate, lighter
 * limit (the latest height wins) and are neither logged nor confirmed.
 */
function useCanvasBridge(
  summary: OrchestratorSummary,
  canvasId: string,
  frame: React.RefObject<HTMLIFrameElement | null>,
  applyHeight: (height: number) => void,
) {
  const navigate = useNavigate();
  const knownHosts = useKnownHosts(summary);
  const log = useAtomCommand(logProjectCanvasAction, { reportFailure: false });
  const [pending, setPending] = useState<{ id: string | null; text: string } | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const history = useRef<number[]>([]);
  const resizeHistory = useRef<number[]>([]);
  const deferredHeight = useRef<number | null>(null);
  const resizeTimer = useRef<number | null>(null);
  const statusTimer = useRef<number | null>(null);
  const reply = (id: string | null, ok: boolean, reason?: string) =>
    frame.current?.contentWindow?.postMessage(
      { type: CANVAS_RESULT_TYPE, id, ok, ...(reason ? { reason } : {}) },
      "*",
    );
  const record = (
    intent: string,
    target: string,
    outcome: "done" | "cancelled" | "rejected",
    reason?: string,
  ) =>
    void log({
      environmentId: summary.root.environmentId,
      input: {
        threadId: summary.root.id,
        canvasId,
        intent,
        target: target.slice(0, 500),
        outcome,
        ...(reason ? { reason } : {}),
      },
    });
  const flash = (message: string) => {
    setStatus(message);
    if (statusTimer.current !== null) window.clearTimeout(statusTimer.current);
    statusTimer.current = window.setTimeout(() => setStatus(null), 3_000);
  };
  // Over the resize limit, the newest height waits for the window to pass.
  const resize = (height: number) => {
    if (takeRateSlot(resizeHistory.current, Date.now(), RESIZE_RATE_LIMIT)) {
      deferredHeight.current = null;
      applyHeight(height);
      return;
    }
    deferredHeight.current = height;
    resizeTimer.current ??= window.setTimeout(() => {
      resizeTimer.current = null;
      if (deferredHeight.current !== null) applyHeight(deferredHeight.current);
      deferredHeight.current = null;
    }, RESIZE_RATE_LIMIT.windowMs);
  };
  // The listener is installed once per frame and reads the latest values from here.
  const latest = useRef({ summary, knownHosts, pending, record, reply, flash, resize });
  useEffect(() => {
    latest.current = { summary, knownHosts, pending, record, reply, flash, resize };
  });

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.source !== frame.current?.contentWindow || event.origin !== "null") return;
      const parsed = parseCanvasMessage(event.data);
      if (!parsed) return;
      const { summary, knownHosts, pending, record, reply, flash, resize } = latest.current;
      if (!parsed.ok && parsed.intent === "resize") {
        reply(parsed.id, false, parsed.reason);
        return;
      }
      if (parsed.ok && parsed.action.intent === "resize") {
        resize(parsed.action.height);
        reply(parsed.id, true);
        return;
      }
      if (!takeRateSlot(history.current, Date.now())) {
        record(parsed.ok ? parsed.action.intent : parsed.intent, "", "rejected", "rate limited");
        reply(parsed.id, false, "rate limited");
        return;
      }
      if (!parsed.ok) {
        record(parsed.intent, "", "rejected", parsed.reason);
        reply(parsed.id, false, parsed.reason);
        return;
      }
      const { action } = parsed;
      const reject = (target: string, reason: string) => {
        record(action.intent, target, "rejected", reason);
        reply(parsed.id, false, reason);
        flash(`Canvas action refused: ${reason}`);
      };
      switch (action.intent) {
        case "send":
          if (pending) return reject(action.text, "another send is waiting for confirmation");
          setPending({ id: parsed.id, text: action.text });
          return;
        case "open-thread": {
          const thread = [summary.root, ...summary.descendants].find(
            (candidate) => candidate.id === action.threadId,
          );
          if (!thread) return reject(action.threadId, "thread is not in this project");
          record(action.intent, action.threadId, "done");
          reply(parsed.id, true);
          void navigate({
            to: "/$environmentId/$threadId",
            params: buildThreadRouteParams(scopeThreadRef(summary.root.environmentId, thread.id)),
          });
          return;
        }
        case "open-issue":
        case "open-url": {
          const url =
            action.intent === "open-issue"
              ? allowedIssueUrl(action.url, knownHosts)
              : allowedUrl(action.url, knownHosts);
          if (!url) return reject(action.url, "not a known host");
          record(action.intent, url, "done");
          reply(parsed.id, true);
          window.open(url, "_blank", "noopener,noreferrer");
          return;
        }
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [frame, navigate]);

  useEffect(
    () => () => {
      if (statusTimer.current !== null) window.clearTimeout(statusTimer.current);
      if (resizeTimer.current !== null) window.clearTimeout(resizeTimer.current);
    },
    [],
  );

  const confirm = () => {
    if (!pending) return;
    const sent = sendToOrchestrator(summary, pending.text);
    record("send", pending.text, "done");
    reply(pending.id, true);
    setPending(null);
    flash(sent.queued ? "Queued for the orchestrator" : "Sent to the orchestrator");
  };
  const cancel = () => {
    if (!pending) return;
    record("send", pending.text, "cancelled");
    reply(pending.id, false, "cancelled");
    setPending(null);
  };
  return { pending, status, confirm, cancel };
}

/**
 * One orchestrator canvas: a static page it writes in its workspace, shown in a
 * sandboxed frame. Scripts may run, but without allow-same-origin the page has
 * an opaque origin: no T3 session, cookies or storage, and its assets arrive
 * inlined. It reaches T3 only through the action bridge's whitelisted intents.
 */
export function ProjectCanvasWidget({
  summary,
  canvas,
  now,
}: {
  readonly summary: OrchestratorSummary;
  readonly canvas: ProjectCanvasPage;
  readonly now: number;
}) {
  const frame = useRef<HTMLIFrameElement | null>(null);
  const canvasHeight = useCanvasHeight(summary, canvas.id);
  const bridge = useCanvasBridge(summary, canvas.id, frame, canvasHeight.apply);
  return (
    <section className={`min-w-0 ${CANVAS_SPAN[canvas.size]}`}>
      <h2 className="mb-2 flex items-center gap-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
        <span className="truncate">{canvas.title}</span>
        {canvas.updatedAt ? (
          <span className="shrink-0 font-normal normal-case">
            updated {formatIssueAge(canvas.updatedAt, now)} ago
          </span>
        ) : null}
        {bridge.status ? (
          <span role="status" className="truncate font-normal normal-case text-foreground/80">
            {bridge.status}
          </span>
        ) : null}
      </h2>
      {bridge.pending ? (
        <div className="mb-2 flex items-start gap-2 border border-border px-2.5 py-2">
          <p className="min-w-0 flex-1 text-xs whitespace-pre-wrap">
            <span className="text-muted-foreground">Send to the orchestrator: </span>
            {bridge.pending.text}
          </p>
          <Button size="xs" onClick={bridge.confirm}>
            Send
          </Button>
          <Button size="xs" variant="outline" onClick={bridge.cancel}>
            Cancel
          </Button>
        </div>
      ) : null}
      {canvas.html === null ? (
        <p className="text-sm text-muted-foreground">
          The orchestrator can show a page here by writing {canvas.path} in the project.
        </p>
      ) : (
        <div
          className={`${canvasHeight.height === null ? FRAME_HEIGHT[canvas.size] : ""} resize-y overflow-hidden border border-border`}
          style={canvasHeight.height === null ? undefined : { height: canvasHeight.height }}
        >
          <iframe
            ref={frame}
            title={`${canvas.title} canvas`}
            sandbox="allow-scripts"
            referrerPolicy="no-referrer"
            srcDoc={canvas.html}
            className="size-full bg-black"
          />
        </div>
      )}
    </section>
  );
}

/** A manifest problem, shown where the canvases would be. */
export function ProjectCanvasError({ canvas }: { readonly canvas: ProjectCanvas }) {
  if (!canvas.error) return null;
  return (
    <ProjectSection title="Canvas">
      <p className="text-sm text-muted-foreground">{canvas.error}</p>
    </ProjectSection>
  );
}
