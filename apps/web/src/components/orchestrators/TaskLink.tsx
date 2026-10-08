import { createContext, use, type ReactNode } from "react";

import type { TaskRef } from "./taskView.logic";

export type OpenTask = (ref: TaskRef | null) => void;

/** Set by the project page: opens a task in the panel over it, or closes the panel with null. */
export const OpenTaskContext = createContext<OpenTask | null>(null);

/**
 * A task title that opens the in-app task view. Outside a project page there is
 * no panel to open, so it stays a link to the issue itself.
 */
export function TaskTitle({
  task,
  url,
  className,
  children,
}: {
  readonly task: TaskRef;
  readonly url: string;
  readonly className?: string;
  readonly children: ReactNode;
}) {
  const open = use(OpenTaskContext);
  if (!open) {
    return (
      <a href={url} target="_blank" rel="noopener noreferrer" className={className}>
        {children}
      </a>
    );
  }
  return (
    <button type="button" className={`text-left ${className ?? ""}`} onClick={() => open(task)}>
      {children}
    </button>
  );
}
