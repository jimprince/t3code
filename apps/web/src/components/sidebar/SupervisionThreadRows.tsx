import { useMemo, type ReactNode } from "react";
import * as Schema from "effect/Schema";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { supervisionForest, supervisionKey, supervisionVisiblePaths, supervisionIsActive } from "@t3tools/client-runtime/state/forkNesting";
import { useLocalStorage } from "../../hooks/useLocalStorage";
import { SidebarNestedThreadToggle } from "./SidebarNestedThreadToggle";

const EMPTY_KEYS: ReadonlyArray<string> = [];
const KeyList = Schema.Array(Schema.String);

export function useSupervisionSidebar(threads: ReadonlyArray<EnvironmentThreadShell>, openedKey: string | null) {
  const forest = useMemo(() => supervisionForest(threads), [threads]);
  const paths = useMemo(() => supervisionVisiblePaths(forest, openedKey), [forest,openedKey]);
  return { forest, paths };
}

/** Child rows reuse the native row renderer without a subscription to child histories. */
export function SupervisionThreadRows(props: {
  thread: EnvironmentThreadShell;
  supervision: ReturnType<typeof useSupervisionSidebar>;
  renderRow: (thread: EnvironmentThreadShell) => ReactNode;
  children: ReactNode;
}) {
  const key = supervisionKey(props.thread);
  const [expandedKeys,setExpandedKeys] = useLocalStorage("t3code:sidebar:expanded-parents",EMPTY_KEYS,KeyList);
  const expanded = expandedKeys.includes(key);
  const children = props.supervision.forest.children.get(key) ?? [];
  if (children.length === 0) return props.children;
  const toggle = () => setExpandedKeys(keys => keys.includes(key) ? keys.filter(k => k !== key) : [...keys,key]);
  return <div data-supervision-parent={key}>
    <div className="relative">{props.children}
      <div className="flex justify-end gap-2 px-2">{props.thread.settledOverride !== "settled" && !supervisionIsActive(props.thread) && (props.supervision.forest.activeCounts.get(key) ?? 0) > 0 ? <span className="text-xs">Supervising</span> : null}<SidebarNestedThreadToggle count={children.length} activeCount={props.supervision.forest.activeCounts.get(key) ?? 0} expanded={expanded} onToggle={toggle} /></div>
    </div>
    <div className="pl-3">{children.filter(child => expanded || props.supervision.paths.has(supervisionKey(child))).map(child =>
      <SupervisionThreadRows key={supervisionKey(child)} thread={child} supervision={props.supervision} renderRow={props.renderRow}>
        {props.renderRow(child)}
      </SupervisionThreadRows>)}</div>
  </div>;
}
