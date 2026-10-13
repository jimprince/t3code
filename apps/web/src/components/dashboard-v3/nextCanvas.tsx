import type { OrchestratorSummary } from "@t3tools/client-runtime/state/orchestrators";

import { projectCanvasQuery } from "../../state/projectCanvas";
import { useEnvironmentQuery } from "../../state/query";
import { ProjectCanvasWidget } from "../orchestrators/ProjectCanvasWidget";

export const NEXT_CANVAS_ID = "next";

/** The project's "What's next" canvas, shown by the same widget component as the layout's canvases. */
export function NextCanvas({ summary }: { readonly summary: OrchestratorSummary }) {
  const canvas = useEnvironmentQuery(
    projectCanvasQuery({
      environmentId: summary.root.environmentId,
      input: { threadId: summary.root.id },
    }),
  );
  const next = canvas.data?.canvases.find((page) => page.id === NEXT_CANVAS_ID);
  // No collapse scope: this priority canvas starts expanded even if its old widget was collapsed.
  return next ? (
    <ProjectCanvasWidget summary={summary} canvas={next} now={canvas.dataUpdatedAt ?? 0} />
  ) : null;
}
