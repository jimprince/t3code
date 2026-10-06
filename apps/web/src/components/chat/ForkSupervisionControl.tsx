import { newForkCommandId } from "@t3tools/client-runtime/state/fork-thread-ids";
import * as Effect from "effect/Effect";
import { useAtomValue } from "@effect/atom-react";
import { createEnvironmentRpcQueryAtomFamily, createEnvironmentRpcCommand } from "@t3tools/client-runtime/state/runtime";
import { supervisionParents } from "@t3tools/client-runtime/state/fork-nesting";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { ThreadId, type EnvironmentId } from "@t3tools/contracts";
import { AsyncResult } from "effect/unstable/reactivity";
import { useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { connectionAtomRuntime } from "../../connection/runtime";
import { useThreadShells, useProjects } from "../../state/entities";
import { useAtomCommand } from "../../state/use-atom-command";
import { buildThreadRouteParams } from "../../threadRoutes";
import { ThreadDetailsSection } from "./ThreadDetailsSection";

const metadataQuery = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, { label: "fork-supervision", tag: "fork.threads.metadata.list", refreshIntervalMs: 30000 });
const updateMetadata = createEnvironmentRpcCommand(connectionAtomRuntime, { label: "fork-supervision-update", tag: "fork.threads.metadata.update", onSuccess: ({ environmentId }, registry) => Effect.sync(() => registry.refresh(metadataQuery({ environmentId, input: {} }))) });
/** Organizational workers appear beside native execution lineage, never as delegated-task results. */
export function ForkSupervisionControl(props: { environmentId: EnvironmentId; threadId: ThreadId }) {
  const metadata = useAtomValue(metadataQuery({ environmentId: props.environmentId, input: {} }));
  const threads = useThreadShells().filter(thread => thread.environmentId === props.environmentId);
  const projects = useProjects().filter(project => project.environmentId === props.environmentId);
  const navigate = useNavigate();
  const update = useAtomCommand(updateMetadata);
  const [parent, setParent] = useState("");
  if (!AsyncResult.isSuccess(metadata)) return null;
  const parents = supervisionParents(threads, metadata.value);
  const rows = threads.filter(thread => parents.get(thread.id) === props.threadId);
  const currentParent = parents.get(props.threadId) ?? null;
  const setParentId = async (parentThreadId: ThreadId | null) => {
    await update({ environmentId: props.environmentId, input: { commandId: newForkCommandId(), threadId: props.threadId, parentThreadId } });
  };
  return <ThreadDetailsSection headingId="fork-supervision-heading" title="Workers">
    {rows.map(thread => <button type="button" key={thread.id} onClick={() => { void navigate({ to: "/thread/$environmentId/$threadId", params: buildThreadRouteParams(scopeThreadRef(props.environmentId, thread.id)) }); }} className="block w-full truncate px-1.5 py-1 text-left text-xs">
      {thread.title} · {projects.find(project => project.id === thread.projectId)?.title ?? thread.projectId}{thread.settledAt ? " · settled" : ""}
    </button>)}
    <form onSubmit={event => { event.preventDefault(); void setParentId(parent ? ThreadId.make(parent) : null); }}>
      <label className="text-xs">Parent thread <select value={parent} onChange={event => setParent(event.target.value)} className="w-full bg-transparent text-xs">
        <option value="">Top level</option>{threads.filter(thread => thread.id !== props.threadId && thread.archivedAt === null).map(thread => <option key={thread.id} value={thread.id}>{thread.title}</option>)}
      </select></label><button type="submit" className="px-1.5 py-1 text-xs">Move</button>
    </form>
    {currentParent && <button type="button" className="px-1.5 py-1 text-xs" onClick={() => { void setParentId(null); }}>Unnest</button>}
  </ThreadDetailsSection>;
}
