import type { ThreadDisplayStatus } from "@t3tools/client-runtime/state/thread-status";

import { SidebarThreadRowStatus } from "../sidebar/SidebarThreadRowStatus";

const PRESENTATION = {
  approval: { label: "Needs approval", icon: "approval", className: "text-amber-500" },
  input: { label: "Needs input", icon: "input", className: "text-amber-500" },
  working: { label: "Working", icon: "working", className: "text-sky-500" },
  supervising: { label: "Supervising", icon: "supervising", className: "text-sky-500" },
  monitoring: { label: "Monitoring", icon: "monitoring", className: "text-violet-400" },
  failed: { label: "Failed", icon: "failed", className: "text-red-500" },
  ready: { label: "Idle", icon: "done", className: "text-muted-foreground" },
} as const;

export function OrchestratorStatus({ status }: { readonly status: ThreadDisplayStatus }) {
  return <SidebarThreadRowStatus status={PRESENTATION[status]} />;
}
