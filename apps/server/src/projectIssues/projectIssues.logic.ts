import { resolveGiteaRemote } from "@t3tools/shared/sourceControl";
import type {
  GiteaInstanceConfig,
  ProjectIssueRequestSource,
  ProjectIssueStatus,
  ProjectRequestStage,
  RepositoryIdentity,
  ThreadId,
} from "@t3tools/contracts";

/** Labels the Agent Status Board uses for its lanes; the project board reads the same ones. */
export const STATUS_LABELS = ["needs-review", "in-progress", "backlog"] as const;
const ARCHIVED_LABEL = "archived";
/** Marks an issue as a request Brad made (the request ledger). */
export const REQUEST_LABEL = "ask";

/** Request-ledger stage labels: handed over for the next release, and shipped and waiting for Brad's test. */
export const AWAITING_RELEASE_LABEL = "awaiting-release";
export const NEEDS_TEST_LABEL = "needs-test";
/** An idea saved for later: on the roadmap, off the active request list until planned or started. */
export const PARKED_LABEL = "parked";

/**
 * Same derivation as the Agent Status Board's `/api/items`. The ledger's two
 * release stages land in the lane that matches who acts next: a shipped
 * request waiting for Brad's test is his to review, and handed-over work
 * waiting for the release batch is still in progress.
 */
export function deriveProjectIssueStatus(
  state: "open" | "closed",
  labels: ReadonlyArray<string>,
): ProjectIssueStatus {
  const names = new Set(labels.map((label) => label.toLowerCase()));
  if (state === "closed") return names.has(ARCHIVED_LABEL) ? "archived" : "done";
  if (names.has(NEEDS_TEST_LABEL)) return "needs-review";
  if (names.has(AWAITING_RELEASE_LABEL)) return "in-progress";
  for (const status of STATUS_LABELS) if (names.has(status)) return status;
  return "pending";
}

/** Where a request is in its life, from Brad's point of view. */
export function deriveRequestStage(
  state: "open" | "closed",
  labels: ReadonlyArray<string>,
): ProjectRequestStage {
  const names = new Set(labels.map((label) => label.toLowerCase()));
  if (state === "closed") return "settled";
  if (names.has(NEEDS_TEST_LABEL)) return "needs-test";
  if (names.has(AWAITING_RELEASE_LABEL)) return "awaiting-release";
  if (names.has("needs-review")) return "ready";
  if (names.has("in-progress")) return "in-progress";
  return "requested";
}

const REQUEST_MARKER = /<!--\s*t3-request\s+(\{[^\n]*?\})\s*-->/;

/** Hidden provenance line appended to a captured request's issue body. */
export function formatRequestMarker(source: ProjectIssueRequestSource): string {
  return `<!-- t3-request ${JSON.stringify(source)} -->`;
}

export function parseRequestMarker(
  body: string | null | undefined,
): ProjectIssueRequestSource | null {
  const match = body ? REQUEST_MARKER.exec(body) : null;
  if (!match) return null;
  try {
    const value = JSON.parse(match[1]!) as Record<string, unknown>;
    return typeof value.threadId === "string" &&
      typeof value.rootThreadId === "string" &&
      typeof value.messageId === "string" &&
      value.threadId &&
      value.rootThreadId &&
      value.messageId
      ? {
          threadId: value.threadId as ThreadId,
          rootThreadId: value.rootThreadId as ThreadId,
          messageId: value.messageId,
          ...(Number.isInteger(value.item) && (value.item as number) >= 0
            ? { item: value.item as number }
            : {}),
        }
      : null;
  } catch {
    return null;
  }
}

interface TreeThread {
  readonly id: ThreadId;
  readonly parentThreadId?: ThreadId | null | undefined;
}

/** The root thread and every descendant, following parentThreadId links. */
export function collectThreadTree<T extends TreeThread>(
  threads: ReadonlyArray<T>,
  rootThreadId: ThreadId,
): T[] {
  const children = new Map<ThreadId, T[]>();
  for (const thread of threads) {
    if (!thread.parentThreadId) continue;
    const siblings = children.get(thread.parentThreadId) ?? [];
    siblings.push(thread);
    children.set(thread.parentThreadId, siblings);
  }
  const root = threads.find((thread) => thread.id === rootThreadId);
  if (!root) return [];
  const tree: T[] = [];
  const seen = new Set<ThreadId>();
  const queue = [root];
  while (queue.length > 0) {
    const thread = queue.shift()!;
    if (seen.has(thread.id)) continue;
    seen.add(thread.id);
    tree.push(thread);
    queue.push(...(children.get(thread.id) ?? []));
  }
  return tree;
}

/** The thread's topmost ancestor (itself when it has no parent). */
export function findRootThreadId(threads: ReadonlyArray<TreeThread>, threadId: ThreadId): ThreadId {
  const byId = new Map(threads.map((thread) => [thread.id, thread]));
  let current = byId.get(threadId);
  const seen = new Set<ThreadId>();
  while (current?.parentThreadId && !seen.has(current.id)) {
    seen.add(current.id);
    const parent = byId.get(current.parentThreadId);
    if (!parent) break;
    current = parent;
  }
  return current?.id ?? threadId;
}

export interface GiteaRepositoryTarget {
  readonly instance: GiteaInstanceConfig;
  readonly host: string;
  readonly repository: string;
}

export function instanceHost(instance: GiteaInstanceConfig): string {
  return new URL(instance.webOrigin).host.toLowerCase();
}

/**
 * A project's Gitea repository when its remote is on a configured Gitea host.
 * Uses the same remote resolution as Gitea pull-request links, so the board and
 * the ledger accept exactly the hosts the PR badges do.
 */
export function giteaRepositoryForIdentity(
  identity: RepositoryIdentity | null | undefined,
  instances: ReadonlyArray<GiteaInstanceConfig>,
): GiteaRepositoryTarget | null {
  const resolved = identity ? resolveGiteaRemote(identity.locator.remoteUrl, instances) : null;
  return resolved
    ? {
        instance: resolved.instance,
        host: instanceHost(resolved.instance),
        repository: resolved.repository.toLowerCase(),
      }
    : null;
}

/** Last path segment of a workspace root: the tracker-repo name the Agent Status Board uses. */
export function workspaceRepositoryName(workspaceRoot: string): string | null {
  const name = workspaceRoot
    .replace(/[\\/]+$/, "")
    .split(/[\\/]/)
    .pop()
    ?.trim()
    .toLowerCase();
  return name && /^[a-z0-9._-]+$/.test(name) ? name : null;
}

export function repositoryKey(target: { host: string; repository: string }): string {
  return `${target.host.toLowerCase()}/${target.repository.toLowerCase()}`;
}
