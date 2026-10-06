import { useCallback, useMemo } from "react";
import * as Schema from "effect/Schema";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import {
  supervisionForest,
  supervisionVisiblePaths,
} from "@t3tools/client-runtime/state/fork-nesting";
import { useSupervisionMetadata } from "../../state/forkSupervision";
import { useProjects } from "../../state/entities";
import { useLocalStorage } from "../../hooks/useLocalStorage";

const EMPTY_KEYS: ReadonlyArray<string> = [];
const KeyList = Schema.Array(Schema.String);

const toggled = (keys: ReadonlyArray<string>, key: string) =>
  keys.includes(key) ? keys.filter((k) => k !== key) : [...keys, key];

export function useSupervisionSidebar(
  threads: ReadonlyArray<EnvironmentThreadShell>,
  openedKey: string | null,
) {
  const projects = useProjects();
  const projectTitles = useMemo(
    () =>
      new Map(projects.map((project) => [`${project.environmentId}:${project.id}`, project.title])),
    [projects],
  );
  const metadata = useSupervisionMetadata();
  const forest = useMemo(() => supervisionForest(threads, metadata), [threads, metadata]);
  const paths = useMemo(() => supervisionVisiblePaths(forest, openedKey), [forest, openedKey]);
  const [expandedKeys, setExpandedKeys] = useLocalStorage(
    "t3code:sidebar:expanded-parents",
    EMPTY_KEYS,
    KeyList,
  );
  const [expandedGroupKeys, setExpandedGroupKeys] = useLocalStorage(
    "sidebar-nested-tidiness",
    EMPTY_KEYS,
    KeyList,
  );
  const expandedParents = useMemo(() => new Set(expandedKeys), [expandedKeys]);
  const expandedGroups = useMemo(() => new Set(expandedGroupKeys), [expandedGroupKeys]);
  const toggleParent = useCallback(
    (key: string) => setExpandedKeys((keys) => toggled(keys, key)),
    [setExpandedKeys],
  );
  const toggleGroup = useCallback(
    (key: string) => setExpandedGroupKeys((keys) => toggled(keys, key)),
    [setExpandedGroupKeys],
  );
  return {
    forest,
    paths,
    projectTitles,
    expandedParents,
    expandedGroups,
    toggleParent,
    toggleGroup,
  };
}
