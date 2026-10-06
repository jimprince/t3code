import {
  sortPinnedThreadsByOrderKey,
  sortActiveThreadsByOrderKey,
  sortSettledThreads,
} from "@t3tools/client-runtime/state/thread-sort";
import { newForkCommandId } from "@t3tools/client-runtime/state/fork-thread-ids";
import * as Effect from "effect/Effect";
import { createEnvironmentRpcCommand } from "@t3tools/client-runtime/state/runtime";
import {
  connectedSupervisionParents,
  supervisionKey,
} from "@t3tools/client-runtime/state/fork-nesting";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { ThreadId, type EnvironmentId } from "@t3tools/contracts";
import { Fragment, useState, type ReactNode } from "react";
import { useNavigate } from "@tanstack/react-router";
import { connectionAtomRuntime } from "../../connection/runtime";
import { useThreadShells, useProjects } from "../../state/entities";
import { useAtomCommand } from "../../state/use-atom-command";
import { buildThreadRouteParams } from "../../threadRoutes";
import { ThreadDetailsSection } from "./ThreadDetailsSection";

import { supervision, useSupervisionMetadata } from "../../state/forkSupervision";
const metadataQuery = supervision.query;
const updateMetadata = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "fork-supervision-update",
  tag: "fork.threads.metadata.update",
  onSuccess: ({ environmentId }, registry) =>
    Effect.sync(() => registry.refresh(metadataQuery({ environmentId, input: {} }))),
});
export type ForkSupervisionRow = ReturnType<typeof useThreadShells>[number];

/** Organizational workers appear beside native execution lineage, never as delegated-task results. */
export function ForkSupervisionControl(props: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  renderRow?: (thread: ForkSupervisionRow) => ReactNode;
}) {
  const threads = useThreadShells();
  const projects = useProjects();
  const metadata = useSupervisionMetadata();
  const available = new Set(metadata.map((row) => row.environmentId));
  available.add(props.environmentId);
  const navigate = useNavigate();
  const update = useAtomCommand(updateMetadata);
  const [visibleCount, setVisibleCount] = useState(24);
  const [parent, setParent] = useState<string | null>(null);
  if (!available.has(props.environmentId)) return null;
  const parents = connectedSupervisionParents(
    threads.filter((thread) => available.has(thread.environmentId)),
    metadata,
  );
  const ownKey = supervisionKey(props.environmentId, props.threadId);
  const rows = threads.filter(
    (thread) => parents.get(supervisionKey(thread.environmentId, thread.id)) === ownKey,
  );
  const current = metadata.find(
    (row) => row.environmentId === props.environmentId && row.threadId === props.threadId,
  );
  const hasStoredParent = current?.parentThreadId != null || current?.remoteParent != null;
  const setParentId = async (parentThreadId: ThreadId | null) => {
    await update({
      environmentId: props.environmentId,
      input: {
        commandId: newForkCommandId(),
        threadId: props.threadId,
        parentThreadId,
        remoteParent: null,
      },
    });
  };
  const renderDefaultRow = (thread: ForkSupervisionRow) => (
      <button
        type="button"
        onClick={() => {
          void navigate({
            to: "/$environmentId/$threadId",
            params: buildThreadRouteParams(scopeThreadRef(thread.environmentId, thread.id)),
          });
        }}
        className="block w-full truncate px-1.5 py-1 text-left text-xs"
      >
        {thread.title} ·{" "}
        {projects.find(
          (project) =>
            project.environmentId === thread.environmentId && project.id === thread.projectId,
        )?.title ?? thread.projectId}
      </button>
    );
  const renderRow = (thread: ForkSupervisionRow) => (
    <Fragment key={supervisionKey(thread.environmentId, thread.id)}>
      {props.renderRow ? props.renderRow(thread) : renderDefaultRow(thread)}
    </Fragment>
  );
  const active = [
    ...sortPinnedThreadsByOrderKey(rows.filter((thread) => thread.pinnedAt !== null)),
    ...sortActiveThreadsByOrderKey(
      rows.filter((thread) => thread.pinnedAt === null && thread.settledOverride !== "settled"),
    ),
  ];
  const settled = sortSettledThreads(
    rows.filter((thread) => thread.pinnedAt === null && thread.settledOverride === "settled"),
  );
  return (
    <ThreadDetailsSection headingId="fork-supervision-heading" title="Workers">
      {current?.scope && <p className="text-xs">{current.scope}</p>}
      {current?.remoteParent && (
        <p className="text-xs">
          Parent: {current.remoteParent.environmentId} / {current.remoteParent.threadId}
        </p>
      )}
      {active.slice(0, visibleCount).map(renderRow)}
      {settled.length > 0 && (
        <details>
          <summary className="text-xs">Settled workers ({settled.length})</summary>
          {settled.slice(0, visibleCount).map(renderRow)}
        </details>
      )}
      {(active.length > visibleCount || settled.length > visibleCount) && (
        <button
          type="button"
          className="px-1.5 py-1 text-xs"
          onClick={() => setVisibleCount((count) => count + 24)}
        >
          Show more
        </button>
      )}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void setParentId(
            (parent ?? current?.parentThreadId)
              ? ThreadId.make((parent ?? current?.parentThreadId)!)
              : null,
          );
        }}
      >
        <label className="text-xs">
          Parent thread{" "}
          <select
            value={parent ?? current?.parentThreadId ?? ""}
            onChange={(event) => setParent(event.target.value)}
            className="w-full bg-transparent text-xs"
          >
            <option value="">Top level</option>
            {threads
              .filter(
                (thread) =>
                  thread.environmentId === props.environmentId &&
                  thread.id !== props.threadId &&
                  thread.archivedAt === null,
              )
              .map((thread) => (
                <option key={thread.id} value={thread.id}>
                  {thread.title}
                </option>
              ))}
          </select>
        </label>
        <button type="submit" className="px-1.5 py-1 text-xs">
          Move
        </button>
      </form>
      {hasStoredParent && (
        <button
          type="button"
          className="px-1.5 py-1 text-xs"
          onClick={() => {
            void setParentId(null);
          }}
        >
          Unnest
        </button>
      )}
    </ThreadDetailsSection>
  );
}
