import { useAtomCommand } from "../state/use-atom-command";
import { CheckIcon, XIcon } from "lucide-react";
import { useEffect, useRef } from "react";
import type { EnvironmentId } from "@t3tools/contracts";

import { environmentCatalog } from "../connection/catalog";
import { cn } from "../lib/utils";
import { useEnvironments } from "../state/environments";
import {
  clearRestart,
  expireRestart,
  useServerRestartStore,
  useServerRestartTracking,
} from "../state/serverRestart";
import { Button } from "./ui/button";
import {
  describeServerRestart,
  SERVER_RESTART_STEPS,
  serverRestartClearDelayMs,
  serverRestartExpiryDelayMs,
} from "./serverRestartBanner.logic";

function RestartStrip({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const { environments } = useEnvironments();
  const state = useServerRestartStore((store) => store.byEnvironment[environmentId]);
  const retry = useAtomCommand(environmentCatalog.retryNow, { reportFailure: false });

  // Two discrete timers: a finished restart clears itself, a lost server expires at its deadline.
  useEffect(() => {
    if (!state) return;
    const clearIn = serverRestartClearDelayMs(state);
    if (clearIn !== null) {
      const timer = window.setTimeout(() => clearRestart(environmentId), clearIn);
      return () => window.clearTimeout(timer);
    }
    const expireIn = serverRestartExpiryDelayMs(state, Date.now());
    if (expireIn !== null) {
      const timer = window.setTimeout(() => expireRestart(environmentId, Date.now()), expireIn);
      return () => window.clearTimeout(timer);
    }
  }, [environmentId, state]);

  if (!state) return null;
  const label =
    environments.length > 1
      ? (environments.find((environment) => environment.environmentId === environmentId)?.label ??
        null)
      : null;
  const model = describeServerRestart(state, label);
  if (model === null) return null;
  const { stepsDone } = model;

  return (
    <div
      role={model.tone === "failed" ? "alert" : "status"}
      // Leaves room for the macOS window controls when the shell reserved it.
      style={{ paddingLeft: "var(--workspace-controls-left, 0.75rem)" }}
      className={cn(
        "flex min-h-7 items-center gap-2 px-3 text-xs",
        model.tone === "failed"
          ? "bg-error-surface text-error-foreground"
          : "bg-update-surface text-update-foreground",
      )}
    >
      <span className="font-medium text-foreground">{model.title}</span>
      {model.detail ? <span className="text-muted-foreground">· {model.detail}</span> : null}
      {model.manualUpdateCommand ? (
        <code className="truncate rounded bg-card px-1.5 py-0.5 text-foreground">
          {model.manualUpdateCommand}
        </code>
      ) : null}
      <span className="ml-auto flex items-center gap-2">
        {stepsDone !== null
          ? SERVER_RESTART_STEPS.map((step, index) => (
              <span
                key={step}
                className={cn(
                  "inline-flex items-center gap-1",
                  index === stepsDone ? "text-foreground" : "text-muted-foreground",
                )}
              >
                {index < stepsDone ? <CheckIcon className="size-3" /> : null}
                {step}
              </span>
            ))
          : null}
        {model.tone === "failed" ? (
          <>
            {model.canRetry ? (
              <Button size="xs" variant="outline" onClick={() => void retry(environmentId)}>
                Retry connection
              </Button>
            ) : null}
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label="Dismiss"
              onClick={() => clearRestart(environmentId)}
            >
              <XIcon />
            </Button>
          </>
        ) : null}
      </span>
      {stepsDone !== null ? (
        <div aria-hidden className="absolute inset-x-0 bottom-0 flex h-px gap-px">
          {SERVER_RESTART_STEPS.map((step, index) => (
            <span
              key={step}
              className={cn("flex-1", index <= stepsDone ? "bg-update" : "bg-border")}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

/**
 * The strip across the top of the shell while a server updates and restarts: installing,
 * restarting, reconnecting, then "updated" (clears itself) or "did not come back" with Retry.
 * It floats over the top edge only while a restart is being shown.
 */
export function ServerRestartBanner() {
  useServerRestartTracking();
  const restartingIds = useServerRestartStore((store) =>
    Object.entries(store.byEnvironment)
      .filter(([, state]) => state.status !== "idle")
      .map(([environmentId]) => environmentId)
      .join("\n"),
  );
  const banner = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = banner.current;
    const reserve = () =>
      document.documentElement.style.setProperty(
        "--server-restart-banner-height",
        `${element?.getBoundingClientRect().height ?? 0}px`,
      );
    reserve();
    if (!element) return;
    const observer = new ResizeObserver(reserve);
    observer.observe(element);
    return () => {
      observer.disconnect();
      document.documentElement.style.removeProperty("--server-restart-banner-height");
    };
  }, [restartingIds]);
  if (restartingIds === "") return null;
  return (
    <div ref={banner} className="fixed inset-x-0 top-0 z-50 flex flex-col bg-background">
      {restartingIds.split("\n").map((environmentId) => (
        <div key={environmentId} className="relative">
          <RestartStrip environmentId={environmentId as EnvironmentId} />
        </div>
      ))}
    </div>
  );
}
