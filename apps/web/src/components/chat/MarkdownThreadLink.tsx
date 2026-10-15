import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import {
  threadLinkTarget,
  type ThreadLinkResolution,
} from "@t3tools/client-runtime/state/thread-link-resolution";
import type { EnvironmentId, OrchestrationV2ThreadShell, ThreadId } from "@t3tools/contracts";
import { formatThreadLink } from "@t3tools/shared/threadLinks";
import { Link } from "@tanstack/react-router";
import { MessageSquareTextIcon } from "lucide-react";

import { useProject } from "../../state/entities";
import { useThreadLink } from "../../state/threadLinks";
import { ProjectFavicon } from "../ProjectFavicon";

type Resolution = ThreadLinkResolution<OrchestrationV2ThreadShell>;

function machines(labels: ReadonlyArray<string>): string {
  return labels.join(", ");
}

/** What hovering a thread link says, in plain words. Nothing while a machine is still loading. */
function threadLinkTooltip(link: Resolution, projectTitle: string | undefined) {
  switch (link.kind) {
    case "found":
      if (link.inPreferredEnvironment) return projectTitle;
      return projectTitle === undefined ? link.label : `${projectTitle} · ${link.label}`;
    case "ambiguous":
      return `On several machines: ${machines(link.candidates.map((candidate) => candidate.label))}`;
    case "unavailable":
      if (link.reason === "not-found")
        return "Not found on any connected machine (it may be archived)";
      if (link.reason === "disconnected") {
        return `${machines(link.environments)} ${link.environments.length === 1 ? "is" : "are"} disconnected`;
      }
      return undefined;
  }
}

/**
 * A `t3-thread://` link in chat. It shows the thread's current title, so a rename
 * reaches every message that links to it, and leads with the thread's project icon
 * the way a web link leads with its favicon. `label` is what the message wrote,
 * shown only when this client cannot see the thread. The link names no environment, so
 * the thread is looked up in the message's own environment first and then in every other
 * connected one; it opens in whichever holds it. A thread that cannot be found, or whose id
 * several other machines hold, still opens in the message's environment (archived threads are
 * not in the index but still open), and the tooltip says why.
 */
export function MarkdownThreadLink(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly label: string;
}) {
  const link = useThreadLink(props.environmentId, props.threadId);
  const found = link.kind === "found" ? link : null;
  const project = useProject(
    found === null ? null : scopeProjectRef(found.environmentId, found.thread.projectId),
  );
  const target = threadLinkTarget(link, props);
  const threadId = target.threadId;
  const title = found?.thread.title.trim() || props.label;
  const tooltip = threadLinkTooltip(link, project?.title);
  const copy = formatThreadLink(threadId, title);
  return (
    <Link
      to="/$environmentId/$threadId"
      params={{ environmentId: target.environmentId, threadId }}
      title={tooltip}
      data-markdown-copy={copy}
    >
      <span
        className="ms-[0.25em] me-[0.2em] inline-flex size-[14px] [vertical-align:-0.125em]"
        aria-hidden
      >
        {project === null ? (
          <MessageSquareTextIcon className="block size-full shrink-0" />
        ) : (
          <ProjectFavicon project={project} className="size-full" />
        )}
      </span>
      {title}
    </Link>
  );
}
