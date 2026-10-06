import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, ProjectLayout, ThreadId } from "@t3tools/contracts";
import { defaultProjectLayoutTabs, WS_METHODS } from "@t3tools/contracts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "@t3tools/client-runtime/state/runtime";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";
import { environmentServerConfigsAtom } from "./server";

/** The project's layout now, then every new revision, pushed by the server. */
const projectLayoutSubscription = createEnvironmentRpcSubscriptionAtomFamily(
  connectionAtomRuntime,
  {
    label: "environment-data:project-layout:subscribe",
    tag: WS_METHODS.subscribeProjectLayout,
  },
);

export const applyProjectLayout = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:project-layout:apply",
  tag: WS_METHODS.projectLayoutApply,
});

export interface ProjectLayoutState {
  readonly layout: ProjectLayout;
  /** False on servers without layouts, or before the first revision arrives: read-only default. */
  readonly live: boolean;
}

const layoutKey = (environmentId: EnvironmentId, threadId: ThreadId) =>
  `${environmentId}\u0000${threadId}`;

const projectLayoutAtom = Atom.family((key: string) => {
  const [environmentId, threadId] = key.split("\u0000") as [EnvironmentId, ThreadId];
  const fallback: ProjectLayout = {
    rootThreadId: threadId,
    revision: 0,
    updatedAt: null,
    updatedBy: null,
    tabs: defaultProjectLayoutTabs(null),
  };
  return Atom.make((get): ProjectLayoutState => {
    const supported =
      get(environmentServerConfigsAtom).get(environmentId)?.environment.capabilities
        .projectLayout === true;
    if (!supported) return { layout: fallback, live: false };
    const result = get(projectLayoutSubscription({ environmentId, input: { threadId } }));
    return Option.match(AsyncResult.value(result), {
      onNone: () => ({ layout: fallback, live: false }),
      onSome: (layout) => ({ layout, live: true }),
    });
  }).pipe(Atom.withLabel(`web-project-layout:${key}`));
});

/**
 * The project page's layout, live: every client re-renders as soon as Brad, the
 * orchestrator or the CLI changes it. Older servers get the default layout.
 */
export function useProjectLayout(environmentId: EnvironmentId, threadId: ThreadId) {
  return useAtomValue(projectLayoutAtom(layoutKey(environmentId, threadId)));
}
