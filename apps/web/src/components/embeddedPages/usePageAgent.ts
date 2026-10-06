import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  DEFAULT_BROWSER_PROFILE_ID,
  makePageAgentThreadId,
  ModelSelection,
  type EnvironmentId,
  type ScopedThreadRef,
  ThreadId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { RegistryContext } from "@effect/atom-react";
import type { AtomRegistry } from "effect/unstable/reactivity";
import { useCallback, useContext, useEffect, useMemo, useRef } from "react";

import { previewRuntimeTabId } from "~/browser/previewRuntimeTabId";
import { useLocalStorage } from "~/hooks/useLocalStorage";
import { randomUUID } from "~/lib/utils";
import {
  readThreadPreviewState,
  reconcilePreviewServerSessions,
  useThreadPreviewState,
} from "~/previewStateStore";
import { useThreadProjection, useThreadStatus } from "~/state/entities";
import { previewEnvironment } from "~/state/preview";
import { threadEnvironment } from "~/state/threads";
import { useAtomCommand } from "~/state/use-atom-command";
import { useAtomQueryRunner } from "~/state/use-atom-query-runner";

import { closePreviewSession } from "../preview/closePreviewSession";
import { openPreviewSession } from "../preview/openPreviewSession";
import { usePreviewSession } from "../preview/usePreviewSession";
import {
  createPendingTabCloses,
  ensurePageAgentTab,
  isPageAgentRunning,
  newPageAgentConversation,
  PageAgentConversations,
} from "./pageAgent.logic";

const StoredConversations = Schema.NullOr(PageAgentConversations);

export function newPageAgentThreadId(pageId: string): string {
  return makePageAgentThreadId(pageId, randomUUID());
}

/**
 * The page's tray conversations on this device. A page always has a current
 * conversation id, because the desktop page view is hosted as that
 * conversation's browser tab before anything is sent.
 */
export function usePageAgentConversations(environmentId: EnvironmentId, pageId: string) {
  const [stored, setStored] = useLocalStorage(
    `t3code:page-agent:${environmentId}:${pageId}`,
    null,
    StoredConversations,
  );
  useEffect(() => {
    if (stored === null) {
      setStored(newPageAgentConversation(null, newPageAgentThreadId(pageId)).conversations);
    }
  }, [pageId, setStored, stored]);
  const threadRef = useMemo(
    () => (stored === null ? null : scopeThreadRef(environmentId, ThreadId.make(stored.current))),
    [environmentId, stored],
  );
  // Conversations waiting to be deleted. Kept until the deletion lands, because
  // one with a running turn must wait for that turn to finish.
  const [pendingDeletes, setPendingDeletes] = useLocalStorage(
    `t3code:page-agent:${environmentId}:${pageId}:pending-deletes`,
    [],
    PendingDeletes,
  );
  const discard = useCallback(
    (threadId: string | null) => {
      if (threadId === null) return;
      setPendingDeletes((list) => (list.includes(threadId) ? list : [...list, threadId]));
    },
    [setPendingDeletes],
  );
  const settleDiscard = useCallback(
    (threadId: string) => setPendingDeletes((list) => list.filter((id) => id !== threadId)),
    [setPendingDeletes],
  );
  return { stored, setStored, threadRef, pendingDeletes, discard, settleDiscard };
}

const PendingDeletes = Schema.Array(Schema.String);

/** Deletes one discarded conversation once it is loaded and has no turn in flight. */
export function usePageAgentDiscard(input: {
  readonly environmentId: EnvironmentId;
  readonly threadId: string;
  readonly onSettled: (threadId: string) => void;
}) {
  const { environmentId, threadId, onSettled } = input;
  const ref = useMemo(
    () => scopeThreadRef(environmentId, ThreadId.make(threadId)),
    [environmentId, threadId],
  );
  const thread = useThreadProjection(ref);
  const status = useThreadStatus(ref);
  const deleteThread = useAtomCommand(threadEnvironment.delete, { reportFailure: false });
  const deletingRef = useRef(false);
  useEffect(() => {
    if (status === "deleted") {
      onSettled(threadId);
      return;
    }
    if (status !== "live" || thread === null || isPageAgentRunning(thread.projection)) return;
    if (deletingRef.current) return;
    deletingRef.current = true;
    void deleteThread({ environmentId, input: { threadId: ref.threadId } }).then((result) => {
      if (result._tag === "Success") onSettled(threadId);
      else deletingRef.current = false;
    });
  }, [deleteThread, environmentId, onSettled, ref.threadId, status, thread, threadId]);
}

/** Stops a conversation's turn whenever its tray is closed, so it cannot act unseen. */
export function usePageAgentClosedTrayGuard(input: {
  readonly threadRef: ScopedThreadRef;
  readonly enabled: boolean;
}) {
  const thread = useThreadProjection(input.enabled ? input.threadRef : null);
  const interruptTurn = useAtomCommand(threadEnvironment.interruptTurn, { reportFailure: false });
  const running = thread !== null && isPageAgentRunning(thread.projection);
  const { environmentId, threadId } = input.threadRef;
  useEffect(() => {
    if (running) void interruptTurn({ environmentId, input: { threadId } });
  }, [environmentId, interruptTurn, running, threadId]);
}

const RememberedModel = Schema.NullOr(ModelSelection);

/** The model last picked in any tray, shared by every page. */
export function useRememberedPageAgentModel() {
  return useLocalStorage("t3code:page-agent:model", null, RememberedModel);
}

/** Where each page was last shown, so a new conversation's tab reopens at the same place. */
const lastPageUrls = new Map<string, string>();
const pendingTabCloses = createPendingTabCloses();

/**
 * Hosts the page in the desktop browser as the conversation thread's only
 * preview tab, so that conversation's preview_* tools drive exactly this page.
 * The tab lives while the page view shows it: it closes when the view unmounts
 * or the conversation changes, as the plain page guest did before.
 */
export function usePageAgentBrowserTab(input: {
  readonly threadRef: ScopedThreadRef;
  readonly pageId: string;
  readonly url: string;
  /** False for a deep link, which must open at its own URL rather than where the page was last left. */
  readonly restoreLastUrl: boolean;
}): string | null {
  const { pageId, url, restoreLastUrl } = input;
  const { environmentId, threadId } = input.threadRef;
  const registry = useContext(RegistryContext) as AtomRegistry.AtomRegistry;
  const listPreviews = useAtomQueryRunner(previewEnvironment.list, { reportFailure: false });
  const open = useAtomCommand(previewEnvironment.open, "page tab open");
  const close = useAtomCommand(previewEnvironment.close, { reportFailure: false });
  const threadRef = useMemo(
    () => scopeThreadRef(environmentId, threadId),
    [environmentId, threadId],
  );
  usePreviewSession(threadRef);
  const state = useThreadPreviewState(threadRef);
  // Read at open time so a settings edit or re-render does not reopen the tab.
  const urlRef = useRef(url);
  useEffect(() => {
    urlRef.current = url;
  }, [url]);

  useEffect(() => {
    let cancelled = false;
    const listTarget = { environmentId, input: { threadId } } as const;
    const pendingKey = `${environmentId}:${threadId}`;
    const closeTab = (tabId: string) => {
      const snapshot = readThreadPreviewState(threadRef).sessions[tabId] ?? null;
      pendingTabCloses.track(
        pendingKey,
        closePreviewSession({ closePreview: close, snapshot, tabId, threadRef }),
      );
    };
    void ensurePageAgentTab({
      syncFromServer: async () => {
        // A previous page's tab must be gone before the server's list can be trusted.
        await pendingTabCloses.settled(pendingKey);
        registry.refresh(previewEnvironment.list(listTarget));
        const listed = await listPreviews(listTarget);
        if (listed._tag !== "Success") return false;
        reconcilePreviewServerSessions(threadRef, listed.value);
        return true;
      },
      hasTab: () => Object.keys(readThreadPreviewState(threadRef).sessions).length > 0,
      openTab: async () => {
        const opened = await openPreviewSession({
          openPreview: open,
          threadRef,
          url: (restoreLastUrl ? lastPageUrls.get(pageId) : undefined) ?? urlRef.current,
          profileId: DEFAULT_BROWSER_PROFILE_ID,
        });
        return opened._tag === "Success" ? opened.value.tabId : null;
      },
      closeTab,
      isCancelled: () => cancelled,
    });
    return () => {
      cancelled = true;
      const current = readThreadPreviewState(threadRef);
      for (const [tabId, snapshot] of Object.entries(current.sessions)) {
        if (tabId === current.activeTabId && snapshot.navStatus._tag !== "Idle") {
          lastPageUrls.set(pageId, snapshot.navStatus.url);
        }
        closeTab(tabId);
      }
    };
    // Every dependency is stable for one conversation; a change here means a new
    // conversation or page, and only then may the live tab close and reopen.
  }, [
    close,
    environmentId,
    listPreviews,
    open,
    pageId,
    registry,
    restoreLastUrl,
    threadId,
    threadRef,
  ]);

  return state.activeTabId === null
    ? null
    : previewRuntimeTabId(threadRef, state.serverEpoch, state.activeTabId);
}
