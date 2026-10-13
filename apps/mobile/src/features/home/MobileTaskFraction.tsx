import type { OrchestratorSummary } from "@t3tools/client-runtime/state/orchestrators";
import {
  taskProgress,
  taskProgressComplete,
  taskProgressDescription,
  taskProgressFraction,
} from "@t3tools/client-runtime/state/projectSubprojects";

import { AppText as Text } from "../../components/AppText";
import { cn } from "../../lib/cn";

/** "24/36" tasks done for a project or subproject row, dimmed once all are; nothing without tasks. */
export function MobileTaskFraction({ summary }: { readonly summary: OrchestratorSummary }) {
  const progress = taskProgress(summary);
  const fraction = taskProgressFraction(progress);
  if (fraction === null) return null;
  return (
    <Text
      accessibilityLabel={taskProgressDescription(progress) ?? undefined}
      className={cn(
        "text-xs text-foreground-muted",
        taskProgressComplete(progress) && "opacity-50",
      )}
    >
      {fraction}
    </Text>
  );
}
