import * as Schema from "effect/Schema";
import { useMemo } from "react";

import { useLocalStorage } from "../../hooks/useLocalStorage";
import {
  EXPANDED_SETTLED_KEY,
  toggleProjectKey,
} from "@t3tools/client-runtime/state/projectSubprojects";

const NO_PROJECT_KEYS: ReadonlyArray<string> = [];
const ProjectKeys = Schema.Array(Schema.String);

/** Which projects' Settled rows are open on this device; the sidebar and the project page share it. */
export interface SettledExpansion {
  readonly expanded: ReadonlyArray<string>;
  readonly toggle: (projectKey: string) => void;
}

export function useSettledExpansion(): SettledExpansion {
  const [expanded, setExpanded] = useLocalStorage(
    EXPANDED_SETTLED_KEY,
    NO_PROJECT_KEYS,
    ProjectKeys,
  );
  return useMemo(
    () => ({
      expanded,
      toggle: (projectKey) => setExpanded((current) => toggleProjectKey(current, projectKey)),
    }),
    [expanded, setExpanded],
  );
}
