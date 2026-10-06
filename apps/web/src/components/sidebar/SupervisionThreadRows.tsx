import { useProjects } from "../../state/entities";
import { SupervisionGroupRow } from "./SupervisionGroupRow";
import { groupQuietChildren, supervisionProjectLabel } from "./nestedThreadVisibility.logic";
import { useMemo, type ReactNode } from "react";
import * as Schema from "effect/Schema";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import {
  supervisionForest,
  supervisionKey,
  supervisionVisiblePaths,
  supervisionIsActive,
} from "@t3tools/client-runtime/state/forkNesting";
import { useLocalStorage } from "../../hooks/useLocalStorage";
import { SidebarNestedThreadToggle } from "./SidebarNestedThreadToggle";

const EMPTY_KEYS: ReadonlyArray<string> = [];
const KeyList = Schema.Array(Schema.String);

export function useSupervisionSidebar(
  threads: ReadonlyArray<EnvironmentThreadShell>,
  openedKey: string | null,
) {
  const projects = useProjects();
  const projectTitles = useMemo(() => new Map(projects.map(project => [`${project.environmentId}:${project.id}`, project.title])), [projects]);
  const forest = useMemo(() => supervisionForest(threads), [threads]);
  const paths = useMemo(() => supervisionVisiblePaths(forest, openedKey), [forest, openedKey]);
  return { forest, paths, projectTitles };
}

/** Child rows reuse the native row renderer without a subscription to child histories. */
export function SupervisionThreadRows(props: {
  thread: EnvironmentThreadShell;
  supervision: ReturnType<typeof useSupervisionSidebar>;
  renderRow: (thread: EnvironmentThreadShell) => ReactNode;
  children: ReactNode;
}) {
  const key = supervisionKey(props.thread);
  const [expandedKeys, setExpandedKeys] = useLocalStorage(
    "t3code:sidebar:expanded-parents",
    EMPTY_KEYS,
    KeyList,
  );
  const expanded = expandedKeys.includes(key);
  const [expandedGroups, setExpandedGroups] = useLocalStorage(
    "sidebar-nested-tidiness",
    EMPTY_KEYS,
    KeyList,
  );
  const children = props.supervision.forest.children.get(key) ?? [];
  if (children.length === 0) return props.children;
  const grouped = groupQuietChildren({
    children,
    parentKey: key,
    visiblePaths: props.supervision.paths,
    activeCounts: props.supervision.forest.activeCounts,
  });
  const renderChild = (child: EnvironmentThreadShell) => (
    <SupervisionThreadRows
      key={supervisionKey(child)}
      thread={child}
      supervision={props.supervision}
      renderRow={props.renderRow}
    >
      {supervisionProjectLabel(child, props.thread) ? (
        <span className="px-2 text-xs">{props.supervision.projectTitles.get(`${child.environmentId}:${child.projectId}`) ?? supervisionProjectLabel(child, props.thread)}</span>
      ) : null}
      {props.renderRow(child)}
    </SupervisionThreadRows>
  );
  const toggle = () =>
    setExpandedKeys((keys) =>
      keys.includes(key) ? keys.filter((k) => k !== key) : [...keys, key],
    );
  return (
    <div data-supervision-parent={key}>
      <div className="relative">
        {props.children}
        <div className="flex justify-end gap-2 px-2">
          {props.thread.settledOverride !== "settled" &&
          !supervisionIsActive(props.thread) &&
          (props.supervision.forest.activeCounts.get(key) ?? 0) > 0 ? (
            <span className="text-xs">Supervising</span>
          ) : null}
          <SidebarNestedThreadToggle
            count={children.length}
            activeCount={props.supervision.forest.activeCounts.get(key) ?? 0}
            expanded={expanded}
            onToggle={toggle}
          />
        </div>
      </div>
      <div className="pl-3">
        {(expanded
          ? grouped.visible
          : children.filter((child) => props.supervision.paths.has(supervisionKey(child)))
        ).map(renderChild)}
        {expanded
          ? grouped.groups.map((group) => (
              <SupervisionGroupRow
                key={group.key}
                group={group}
                expanded={expandedGroups.includes(group.key)}
                onToggle={() =>
                  setExpandedGroups((keys) =>
                    keys.includes(group.key)
                      ? keys.filter((k) => k !== group.key)
                      : [...keys, group.key],
                  )
                }
              >
                {group.children.map(renderChild)}
              </SupervisionGroupRow>
            ))
          : null}
      </div>
    </div>
  );
}
