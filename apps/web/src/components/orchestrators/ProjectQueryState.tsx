import { Button } from "../ui/button";

/**
 * What a project view shows before its data: never an empty pane. "Loading" while
 * the first answer is on its way, or the error with a Retry.
 */
export function ProjectQueryState({
  what,
  error,
  onRetry,
  inline = false,
}: {
  /** What is loading, for example "roadmap". */
  readonly what: string;
  readonly error: string | null;
  readonly onRetry: () => void;
  /** One line inside a summary row instead of a paragraph. */
  readonly inline?: boolean;
}) {
  const Tag = inline ? "span" : "p";
  return (
    <Tag
      role={error ? "alert" : "status"}
      className={`flex min-w-0 items-center gap-2 text-sm text-muted-foreground ${inline ? "" : "py-2"}`}
    >
      <span className="min-w-0 truncate">
        {error ? `Could not load the ${what}: ${error}` : `Loading the ${what}...`}
      </span>
      {error ? (
        <Button size="xs" variant="outline" onClick={onRetry}>
          Retry
        </Button>
      ) : null}
    </Tag>
  );
}
