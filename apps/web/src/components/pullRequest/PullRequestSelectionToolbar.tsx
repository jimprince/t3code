import type { ReactNode } from "react";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { pullRequestEntryKey, type EnvironmentPullRequestEntry } from "./pullRequestList.logic";
import type { LocalPrProject, useLocalPrVisibility } from "./localPrVisibility";

type Visibility = ReturnType<typeof useLocalPrVisibility>;

export function PullRequestSelectionToolbar({
  entries,
  visibility,
  projects,
}: {
  entries: ReadonlyArray<EnvironmentPullRequestEntry>;
  visibility: Visibility;
  projects: ReadonlyArray<LocalPrProject & { readonly title: string }>;
}) {
  const keys = entries.map(pullRequestEntryKey);
  const count = keys.filter((key) => visibility.selected.has(key)).length;
  const all = keys.length > 0 && count === keys.length;
  return (
    <div
      role="toolbar"
      aria-label="Pull request selection"
      className="flex min-h-9 items-center gap-2"
    >
      <Checkbox
        aria-label="Select all visible pull requests"
        checked={all}
        indeterminate={count > 0 && !all}
        disabled={keys.length === 0}
        onCheckedChange={() => visibility.select(keys, !all)}
      />
      <span className="text-xs">{count > 0 ? `${count} selected` : `${keys.length} visible`}</span>
      <span className="flex-1" />
      <details>
        <summary className="cursor-pointer text-xs">
          Hidden projects ({visibility.excludedCount})
        </summary>
        <div className="flex flex-col gap-2">
          {projects.map((project) => (
            <label
              key={JSON.stringify([project.environmentId, project.id])}
              className="flex items-center gap-2 text-xs"
            >
              <Checkbox
                checked={visibility.isProjectExcluded(project)}
                onCheckedChange={(checked) => visibility.excludeProject(project, checked)}
              />
              {project.title} ({project.environmentId})
            </label>
          ))}
        </div>
      </details>
      {visibility.excludedCount > 0 ? (
        <Button size="xs" variant="ghost" onClick={visibility.restoreProjects}>
          Show all projects
        </Button>
      ) : null}
      {visibility.removedCount > 0 ? (
        <Button size="xs" variant="ghost" onClick={visibility.restore}>
          Restore removed ({visibility.removedCount})
        </Button>
      ) : null}
      {count > 0 ? (
        <Button size="xs" variant="outline" onClick={() => visibility.dismiss(entries)}>
          Remove from list
        </Button>
      ) : null}
    </div>
  );
}

/** Selection is a sibling of the native interactive row, including its quick actions and drag sensor. */
export function PullRequestSelectionRow({
  entry,
  visibility,
  children,
}: {
  entry: EnvironmentPullRequestEntry;
  visibility: Visibility;
  children: ReactNode;
}) {
  const key = pullRequestEntryKey(entry);
  return (
    <div className="flex items-center gap-2">
      <Checkbox
        aria-label={`Select pull request #${entry.number}`}
        checked={visibility.selected.has(key)}
        onCheckedChange={(checked) => visibility.select([key], checked)}
      />
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}
