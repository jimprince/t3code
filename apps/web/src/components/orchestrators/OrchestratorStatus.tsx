import type { ThreadDisplayStatus } from "@t3tools/client-runtime/state/thread-status";

import { SidebarThreadRowStatus } from "../sidebar/SidebarThreadRowStatus";

const PRESENTATION = {
  approval: { label: "Needs approval", icon: "approval", className: "text-warning-foreground" },
  input: { label: "Needs input", icon: "input", className: "text-warning-foreground" },
  working: { label: "Working", icon: "working", className: "text-info" },
  supervising: { label: "Supervising", icon: "supervising", className: "text-info" },
  monitoring: { label: "Monitoring", icon: "monitoring", className: "text-info" },
  failed: { label: "Failed", icon: "failed", className: "text-error" },
  ready: { label: "Idle", icon: "done", className: "text-muted-foreground" },
} as const;

export function OrchestratorStatus({ status }: { readonly status: ThreadDisplayStatus }) {
  return <SidebarThreadRowStatus status={PRESENTATION[status]} />;
}
