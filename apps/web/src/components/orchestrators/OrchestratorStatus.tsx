import type { ThreadDisplayStatus } from "@t3tools/client-runtime/state/orchestrators";
import {
  CircleAlertIcon,
  CircleCheckIcon,
  CircleDashedIcon,
  EyeIcon,
  MessageCircleQuestionIcon,
  ShieldQuestionIcon,
  type LucideIcon,
} from "lucide-react";

import { cn } from "~/lib/utils";

const PRESENTATION: Record<
  ThreadDisplayStatus,
  { readonly label: string; readonly icon: LucideIcon; readonly className: string }
> = {
  approval: {
    label: "Needs approval",
    icon: ShieldQuestionIcon,
    className: "text-warning-foreground",
  },
  input: {
    label: "Needs input",
    icon: MessageCircleQuestionIcon,
    className: "text-warning-foreground",
  },
  working: { label: "Working", icon: CircleDashedIcon, className: "text-info" },
  supervising: { label: "Supervising", icon: CircleDashedIcon, className: "text-info" },
  monitoring: { label: "Monitoring", icon: EyeIcon, className: "text-info" },
  failed: { label: "Failed", icon: CircleAlertIcon, className: "text-error" },
  ready: { label: "Idle", icon: CircleCheckIcon, className: "text-muted-foreground" },
};

export function OrchestratorStatus({ status }: { readonly status: ThreadDisplayStatus }) {
  const { label, icon: Icon, className } = PRESENTATION[status];
  return (
    <span className={cn("inline-flex items-center gap-1 font-medium", className)}>
      <Icon aria-hidden className="size-4 shrink-0" />
      <span role="status">{label}</span>
    </span>
  );
}
