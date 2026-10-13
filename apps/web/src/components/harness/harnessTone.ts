import type { HarnessTone } from "@t3tools/client-runtime/state/harness-view";

/** Status dot colour for a check's tone, shared by the sidebar rows and the check page. */
export const TONE_DOT: Record<HarnessTone, string> = {
  error: "bg-error",
  warning: "bg-warning",
  muted: "bg-muted-foreground/40",
  ok: "bg-success",
};
