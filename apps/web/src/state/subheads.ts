import { useAtomValue } from "@effect/atom-react";
import {
  buildSubheadRows,
  type SubheadRowView,
} from "@t3tools/client-runtime/state/subheads-view";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
} from "@t3tools/client-runtime/state/runtime";
import { NamedAgentName, type EnvironmentId, type Subhead, type SubheadRunRow } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { AsyncResult, Atom } from "effect/reactivity";
import { useCallback, useMemo } from "react";

import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { environmentPresentations } from "./presentation";
import { environmentServerConfigsAtom } from "./server";
import { formatEnvironmentQueryError } from "./query";

/**
 * Every `fork.subheads` call shares one tag; the operation in the input picks the read. A server
 * that predates the tag answers with an error, which the sidebar shows as no subheads.
 */
const subheadsQuery = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "environment-data:subheads",
  tag: "fork.subheads",
  staleTimeMs: 10_000,
  refreshIntervalMs: 15_000,
  idleTtlMs: 0,
});

/** The only write path from the UI: send, edit, enable, disable and retire go through it. */
export const subheadCommand = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:subheads:command",
  tag: "fork.subheads",
  onSuccess: ({ environmentId }) =>
    Effect.sync(() => refreshSubheadsFor(environmentId)),
});

const isNamedAgentName = Schema.is(NamedAgentName);
const LIST_INPUT = { operation: "list", all: true } as const;
/** Open runs plus the newest finished one of each subhead: all the sidebar rows need. */
const SIDEBAR_RUNS_INPUT = { operation: "runs", perSubhead: 1 } as const;
const PAGE_HISTORY_LIMIT = 50;

const listQuery = (environmentId: EnvironmentId) =>
  subheadsQuery({ environmentId, input: LIST_INPUT });
const sidebarRunsQuery = (environmentId: EnvironmentId) =>
  subheadsQuery({ environmentId, input: SIDEBAR_RUNS_INPUT });
const pageRunsQuery = (environmentId: EnvironmentId, name: NamedAgentName) =>
  subheadsQuery({
    environmentId,
    input: { operation: "runs", name, perSubhead: PAGE_HISTORY_LIMIT } as const,
  });

function refreshSubheadsFor(environmentId: EnvironmentId) {
  appAtomRegistry.refresh(listQuery(environmentId));
  appAtomRegistry.refresh(sidebarRunsQuery(environmentId));
}

const subheadsOf = (value: unknown): ReadonlyArray<Subhead> =>
  typeof value === "object" && value !== null && "agents" in value
    ? (value as { agents: ReadonlyArray<Subhead> }).agents
    : [];
const runsOf = (value: unknown): ReadonlyArray<SubheadRunRow> =>
  typeof value === "object" && value !== null && "runs" in value
    ? (value as { runs: ReadonlyArray<SubheadRunRow> }).runs
    : [];

export interface SubheadEnvironmentView {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly rows: ReadonlyArray<SubheadRowView>;
  /** Set only while no read has ever succeeded, so a blip never empties a list. */
  readonly error: string | null;
}

/** Environments that serve the Harness, each with its own subhead rows. */
const subheadEnvironmentsAtom = Atom.make((get): ReadonlyArray<SubheadEnvironmentView> => {
  const presentations = get(environmentPresentations.presentationsAtom);
  const configs = get(environmentServerConfigsAtom);
  const views: SubheadEnvironmentView[] = [];
  for (const [environmentId, presentation] of presentations) {
    if (configs.get(environmentId)?.environment.capabilities.harness !== true) continue;
    const list = get(listQuery(environmentId));
    const runs = get(sidebarRunsQuery(environmentId));
    const subheads = Option.match(AsyncResult.value(list), {
      onNone: () => [],
      onSome: subheadsOf,
    });
    views.push({
      environmentId,
      label: presentation.entry.target.label,
      rows: buildSubheadRows({
        environmentId,
        subheads,
        runs: Option.match(AsyncResult.value(runs), { onNone: () => [], onSome: runsOf }),
      }),
      error:
        list._tag === "Failure" && Option.isNone(AsyncResult.value(list))
          ? formatEnvironmentQueryError(list.cause)
          : null,
    });
  }
  return views;
}).pipe(Atom.withLabel("web-subheads:environments"));

/** Subhead rows for the Harness list; read only while a mounted view subscribes. */
export function useSubheadEnvironments(): ReadonlyArray<SubheadEnvironmentView> {
  return useAtomValue(subheadEnvironmentsAtom);
}

export interface SubheadPageData {
  readonly subhead: Subhead | null;
  readonly runs: ReadonlyArray<SubheadRunRow>;
  readonly loading: boolean;
  readonly error: string | null;
  readonly refresh: () => void;
}

/** One subhead's template and its run history for the detail page. */
export function useSubheadPage(environmentId: EnvironmentId, name: string): SubheadPageData {
  const list = useAtomValue(listQuery(environmentId));
  // A name that cannot exist reads the sidebar's runs, which the filter below then empties.
  const runsAtom = useMemo(
    () =>
      isNamedAgentName(name)
        ? pageRunsQuery(environmentId, name)
        : sidebarRunsQuery(environmentId),
    [environmentId, name],
  );
  const runs = useAtomValue(runsAtom);
  const refresh = useCallback(() => {
    appAtomRegistry.refresh(listQuery(environmentId));
    appAtomRegistry.refresh(runsAtom);
    appAtomRegistry.refresh(sidebarRunsQuery(environmentId));
  }, [environmentId, runsAtom]);
  const subhead = Option.match(AsyncResult.value(list), {
    onNone: () => null,
    onSome: (value) => subheadsOf(value).find((entry) => entry.name === name) ?? null,
  });
  return {
    subhead,
    runs: Option.match(AsyncResult.value(runs), {
      onNone: () => [],
      onSome: (value) => runsOf(value).filter((run) => run.subheadName === name),
    }),
    loading: list.waiting && subhead === null,
    error:
      list._tag === "Failure"
        ? formatEnvironmentQueryError(list.cause)
        : runs._tag === "Failure"
          ? formatEnvironmentQueryError(runs.cause)
          : null,
    refresh,
  };
}
