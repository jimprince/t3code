import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { useRouter } from "@tanstack/react-router";

import { useThreadShell } from "~/state/entities";
import { isNestedUnder } from "~/threadNesting.logic";
import { buildThreadRouteParams } from "~/threadRoutes";
import {
  WorkspaceBreadcrumbItem,
  WorkspaceBreadcrumbSeparator,
  WorkspaceBreadcrumbText,
} from "../WorkspaceBreadcrumb";

/**
 * Breadcrumb step for a nested thread: its parent, between the project and
 * the thread title, so the way back is one click. Renders nothing for
 * top-level threads.
 */
export function NestedThreadParentCrumb({ threadRef }: { threadRef: ScopedThreadRef | null }) {
  const router = useRouter();
  const thread = useThreadShell(threadRef);
  const parent = useThreadShell(
    thread?.parentThreadId ? scopeThreadRef(thread.environmentId, thread.parentThreadId) : null,
  );
  if (thread === null || parent === null || !isNestedUnder(thread, parent)) return null;
  const parentRef = scopeThreadRef(parent.environmentId, parent.id);
  return (
    <>
      <WorkspaceBreadcrumbItem className="shrink">
        <button
          type="button"
          aria-label={`Open parent thread ${parent.title}`}
          onClick={() =>
            void router.navigate({
              to: "/$environmentId/$threadId",
              params: buildThreadRouteParams(parentRef),
            })
          }
          className="inline-flex min-w-0 max-w-full cursor-pointer items-center rounded-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
        >
          <WorkspaceBreadcrumbText className="max-w-48">{parent.title}</WorkspaceBreadcrumbText>
        </button>
      </WorkspaceBreadcrumbItem>
      <WorkspaceBreadcrumbSeparator>
        <WorkspaceBreadcrumbText>/</WorkspaceBreadcrumbText>
      </WorkspaceBreadcrumbSeparator>
    </>
  );
}
