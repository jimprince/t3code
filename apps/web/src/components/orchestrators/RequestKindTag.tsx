import type { RequestKind } from "./projectRequests.logic";

/** An item's type, with a small `bug` tag when it is one. */
export function RequestKindTag({
  kind,
  bug,
  className = "text-xs text-muted-foreground",
}: {
  readonly kind: RequestKind | null;
  readonly bug: boolean;
  readonly className?: string;
}) {
  if (kind === null && !bug) return null;
  return (
    <span className={className}>
      {kind}
      {bug ? <span className="ml-1 text-destructive">bug</span> : null}
    </span>
  );
}
