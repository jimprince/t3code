import {
  CircleAlertIcon,
  CircleCheckIcon,
  CircleDashedIcon,
  EyeIcon,
  MessageCircleQuestionIcon,
  ShieldQuestionIcon,
} from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "~/lib/utils";

export type SidebarThreadRowStatusValue = {
  label: string;
  icon: "working" | "supervising" | "input" | "approval" | "failed" | "monitoring" | "done";
  className: string;
};

/** Static status content shared by ordinary and nested sidebar thread rows. */
export function SidebarThreadRowStatus({
  status,
  trailing,
}: {
  status: SidebarThreadRowStatusValue;
  trailing?: ReactNode;
}) {
  const Icon =
    status.icon === "working" || status.icon === "supervising"
      ? CircleDashedIcon
      : status.icon === "input"
        ? MessageCircleQuestionIcon
        : status.icon === "approval"
          ? ShieldQuestionIcon
          : status.icon === "failed"
            ? CircleAlertIcon
            : status.icon === "monitoring"
              ? EyeIcon
              : CircleCheckIcon;
  return (
    <span className={cn("inline-flex items-center gap-1 font-medium", status.className)}>
      <Icon aria-hidden className="size-4 shrink-0" />
      <span role="status">{status.label}</span>
      {trailing}
    </span>
  );
}
