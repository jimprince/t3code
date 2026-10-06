import type {
  EmbeddedPage,
  ModelSelection,
  OrchestrationV2AppThread,
  OrchestrationV2ProjectedTurnItem,
  OrchestrationV2ProviderSession,
  OrchestrationV2Run,
  ProviderInstanceId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

/**
 * A page's tray conversations: the one the tray shows and the one before it,
 * which "Resume previous" swaps back in. A conversation's thread is created by
 * its first message, so `current` names a thread that does not exist yet while
 * `lastSentAt` is null.
 */
export const PageAgentConversations = Schema.Struct({
  current: Schema.String,
  previous: Schema.NullOr(Schema.String),
  /** When the user last sent to (or resumed) `current`. */
  lastSentAt: Schema.NullOr(Schema.String),
});
export type PageAgentConversations = typeof PageAgentConversations.Type;

/**
 * Opening the tray continues a conversation used within this window and
 * otherwise starts fresh. A page conversation is mostly snapshots of page
 * states that are stale by the next session, and the provider only compacts
 * near its context limit, so continuing indefinitely re-sends that history on
 * every turn for little benefit. The page itself carries the durable context.
 */
export const PAGE_AGENT_IDLE_RESTART_MS = 30 * 60 * 1000;

export interface PageAgentConversationChange {
  readonly conversations: PageAgentConversations;
  /** A conversation pushed out of the two kept per page; its thread should be deleted. */
  readonly discarded: string | null;
}

/**
 * The tray's "New conversation". The current one becomes `previous` and the
 * old `previous` is discarded; a current conversation that was never sent to
 * is simply replaced.
 */
export function newPageAgentConversation(
  stored: PageAgentConversations | null,
  newId: string,
): PageAgentConversationChange {
  const fresh = { current: newId, lastSentAt: null };
  if (stored === null) return { conversations: { ...fresh, previous: null }, discarded: null };
  return stored.lastSentAt === null
    ? { conversations: { ...fresh, previous: stored.previous }, discarded: null }
    : { conversations: { ...fresh, previous: stored.current }, discarded: stored.previous };
}

/** What the tray shows when it opens: the current conversation unless it has gone idle. */
export function openPageAgentConversation(input: {
  readonly stored: PageAgentConversations | null;
  readonly now: number;
  readonly newId: string;
}): PageAgentConversationChange | null {
  const { stored } = input;
  if (stored === null) return newPageAgentConversation(null, input.newId);
  if (stored.lastSentAt === null) return null;
  const idleMs = input.now - Date.parse(stored.lastSentAt);
  return idleMs >= PAGE_AGENT_IDLE_RESTART_MS
    ? newPageAgentConversation(stored, input.newId)
    : null;
}

/** The tray's "Resume previous": swaps the two, so the newer one stays one click away. */
export function resumePreviousPageAgentConversation(
  stored: PageAgentConversations,
  now: string,
): PageAgentConversations | null {
  if (stored.previous === null) return null;
  return {
    current: stored.previous,
    // An unsent conversation has nothing to come back to.
    previous: stored.lastSentAt === null ? null : stored.current,
    lastSentAt: now,
  };
}

/** The tray's "Delete conversation": the previous one moves up, or a fresh one starts. */
export function deletePageAgentConversation(
  stored: PageAgentConversations,
  newId: string,
  now: string,
): PageAgentConversations {
  return stored.previous === null
    ? { current: newId, previous: null, lastSentAt: null }
    : { current: stored.previous, previous: null, lastSentAt: now };
}

const PAGE_AGENT_DEFAULT_MODEL = "gpt-6.1-sol";

interface PageAgentModelCandidate {
  readonly instanceId: ProviderInstanceId;
  readonly driverKind: string;
  readonly enabled: boolean;
  readonly isAvailable: boolean;
  readonly models: ReadonlyArray<{ readonly slug: string }>;
}

function offers(entries: ReadonlyArray<PageAgentModelCandidate>, selection: ModelSelection) {
  return entries.some(
    (entry) =>
      entry.instanceId === selection.instanceId &&
      entry.enabled &&
      entry.isAvailable &&
      entry.models.some((model) => model.slug === selection.model),
  );
}

const FAST_SERVICE_TIER = [{ id: "serviceTier", value: "fast" }] as const;

/** A picked tray model; the default model always runs on the fast tier. */
export function pageAgentModelSelection(
  instanceId: ProviderInstanceId,
  model: string,
): ModelSelection {
  return model === PAGE_AGENT_DEFAULT_MODEL
    ? { instanceId, model, options: FAST_SERVICE_TIER }
    : { instanceId, model };
}

/**
 * The model a new tray conversation starts with: the last one picked in any
 * tray, then GPT-6.1 Sol on the fast tier from the first Codex instance that
 * offers it, then the caller's general default.
 */
export function resolvePageAgentModelSelection(input: {
  readonly remembered: ModelSelection | null;
  readonly entries: ReadonlyArray<PageAgentModelCandidate>;
  readonly fallback: ModelSelection | null;
}): ModelSelection | null {
  if (input.remembered !== null && offers(input.entries, input.remembered)) {
    return input.remembered;
  }
  const codex = input.entries.find(
    (entry) =>
      entry.driverKind === "codex" &&
      entry.enabled &&
      entry.isAvailable &&
      entry.models.some((model) => model.slug === PAGE_AGENT_DEFAULT_MODEL),
  );
  if (codex !== undefined) {
    return pageAgentModelSelection(codex.instanceId, PAGE_AGENT_DEFAULT_MODEL);
  }
  return input.fallback;
}

const PREAMBLE_OPEN = "<page-agent-context>";
const PREAMBLE_CLOSE = "</page-agent-context>";

/**
 * Instructions sent ahead of a conversation's first message. They travel in
 * the message so every provider receives them the same way, and the tray
 * strips them when it renders the message.
 */
export function buildPageAgentPreamble(page: Pick<EmbeddedPage, "name" | "url">): string {
  return [
    PREAMBLE_OPEN,
    `You are the assistant in T3 Code's side tray for the page "${page.name}" (${page.url}), which the user sees next to this chat.`,
    "Operate that page with the t3-code preview_* tools: take a preview_snapshot first, then use preview_click, preview_type, preview_press, preview_navigate, or preview_evaluate. They act only on this page. Stay on this page and do not open new tabs.",
    'To read or message T3 Code threads, use the `t3-thread` CLI (for example `t3-thread search <uuid>`, `t3-thread status <uuid>`, `t3-thread result <uuid> --final-message`, `t3-thread send <uuid> "..."`).',
    "Keep replies short.",
    PREAMBLE_CLOSE,
    "",
    "",
  ].join("\n");
}

export function stripPageAgentPreamble(text: string): string {
  if (!text.startsWith(PREAMBLE_OPEN)) return text;
  const end = text.indexOf(PREAMBLE_CLOSE);
  return end === -1 ? text : text.slice(end + PREAMBLE_CLOSE.length).trimStart();
}

const ACTIVE_RUN_STATUSES: ReadonlySet<OrchestrationV2Run["status"]> = new Set([
  "preparing",
  "queued",
  "starting",
  "running",
  "waiting",
]);

/**
 * Whether a conversation has a turn in flight (the same active-run statuses
 * the thread work classifier counts). Such a conversation is never deleted,
 * and the page view stops it while the tray is closed.
 */
export function isPageAgentRunning(thread: {
  readonly runs: ReadonlyArray<Pick<OrchestrationV2Run, "status">>;
}): boolean {
  return thread.runs.some((run) => ACTIVE_RUN_STATUSES.has(run.status));
}

/**
 * What the agent is doing right now: the latest tool call or command of the active
 * run. Items of earlier runs never name current work.
 */
export function pageAgentActivityLabel(
  items: ReadonlyArray<OrchestrationV2ProjectedTurnItem>,
  runs: ReadonlyArray<Pick<OrchestrationV2Run, "id" | "status">>,
): string | null {
  const active = runs.findLast((run) => ACTIVE_RUN_STATUSES.has(run.status));
  if (active === undefined) return null;
  for (const { item } of items.toReversed()) {
    if (item.runId !== active.id) continue;
    if (item.type === "dynamic_tool" && item.toolName !== null) return item.toolName;
    if (item.type === "command_execution") return item.input;
  }
  return null;
}

/** The newest error of the session that serves the conversation's provider instance. */
export function pageAgentSessionError(thread: {
  readonly thread: Pick<OrchestrationV2AppThread, "providerInstanceId">;
  readonly providerSessions: ReadonlyArray<
    Pick<OrchestrationV2ProviderSession, "providerInstanceId" | "lastError">
  >;
}): string | null {
  return (
    thread.providerSessions.findLast(
      (session) => session.providerInstanceId === thread.thread.providerInstanceId,
    )?.lastError ?? null
  );
}

/**
 * Tracks tab closes that were started but not yet confirmed, per thread, so a page
 * opened right after another can wait for the old tab to be gone instead of reusing it.
 */
export function createPendingTabCloses() {
  const pending = new Map<string, Promise<void>>();
  return {
    track(key: string, closing: Promise<unknown>): void {
      const previous = pending.get(key) ?? Promise.resolve();
      const settled: Promise<void> = Promise.all([previous, closing.catch(() => undefined)]).then(
        () => {
          if (pending.get(key) === settled) pending.delete(key);
        },
      );
      pending.set(key, settled);
    },
    settled(key: string): Promise<void> {
      return pending.get(key) ?? Promise.resolve();
    },
  };
}

/**
 * Gives a page conversation exactly one browser tab: an existing server tab
 * (a renderer reload keeps them) is reused, otherwise one is opened at `url`.
 * The server's list is read directly rather than through a passive
 * subscription, which never settles for a thread nothing else is watching and
 * left the page blank. A tab opened after `isCancelled` turns true (the page
 * view unmounted mid-open) is closed again so no hidden guest outlives the view.
 */
export async function ensurePageAgentTab(deps: {
  /** Fetches the server's tabs for the thread and stores them; false on failure. */
  readonly syncFromServer: () => Promise<boolean>;
  readonly hasTab: () => boolean;
  /** Opens a tab and returns its id, or null when the open failed. */
  readonly openTab: () => Promise<string | null>;
  readonly closeTab: (tabId: string) => void;
  readonly isCancelled: () => boolean;
}): Promise<"reused" | "opened" | "cancelled" | "failed"> {
  await deps.syncFromServer();
  if (deps.isCancelled()) return "cancelled";
  if (deps.hasTab()) return "reused";
  const tabId = await deps.openTab();
  if (tabId === null) return "failed";
  if (deps.isCancelled()) {
    deps.closeTab(tabId);
    return "cancelled";
  }
  return "opened";
}
