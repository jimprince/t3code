import { isPageAgentThreadId } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";

import { resolveEmbeddedPageHost } from "./embeddedPages.logic";
import { ensurePageAgentTab, newPageAgentConversation } from "./pageAgent.logic";
import { newPageAgentThreadId } from "./usePageAgent";

// A server-side tab store shared by every renderer session, as the preview server is.
const makeServer = () => {
  const tabs = new Map<string, string>();
  let nextTab = 0;
  return {
    tabs,
    open: (url: string) => {
      const tabId = `tab-${(nextTab += 1)}`;
      tabs.set(tabId, url);
      return tabId;
    },
  };
};

const session = (server: ReturnType<typeof makeServer>, url: string) => {
  const local = new Set<string>();
  return {
    local,
    run: () =>
      ensurePageAgentTab({
        syncFromServer: async () => {
          for (const tabId of server.tabs.keys()) local.add(tabId);
          return true;
        },
        hasTab: () => local.size > 0,
        openTab: async () => {
          const tabId = server.open(url);
          local.add(tabId);
          return tabId;
        },
        closeTab: (tabId) => {
          local.delete(tabId);
          server.tabs.delete(tabId);
        },
        isCancelled: () => false,
      }),
  };
};

it("desktop hosts each page as its conversation thread's only preview tab", async () => {
  const conversation = newPageAgentConversation(null, newPageAgentThreadId("status-board"));
  expect(isPageAgentThreadId(conversation.conversations.current)).toBe(true);
  expect(
    resolveEmbeddedPageHost("http://status.home", {
      desktopWebview: true,
      appProtocol: "t3code:",
    }).kind,
  ).toBe("webview");

  const server = makeServer();
  expect(await session(server, "http://status.home").run()).toBe("opened");
  // A renderer reload finds the server's tab instead of opening a second one.
  expect(await session(server, "http://status.home").run()).toBe("reused");
  expect([...server.tabs.values()]).toEqual(["http://status.home"]);
});

it("desktop closes a tab opened after the page view unmounted", async () => {
  const server = makeServer();
  let cancelled = false;
  const outcome = await ensurePageAgentTab({
    syncFromServer: async () => true,
    hasTab: () => false,
    openTab: async () => {
      const tabId = server.open("http://status.home");
      cancelled = true;
      return tabId;
    },
    closeTab: (tabId) => server.tabs.delete(tabId),
    isCancelled: () => cancelled,
  });
  expect(outcome).toBe("cancelled");
  expect(server.tabs.size).toBe(0);
});

it("web keeps the page in a frame, so the tray offers chat only", () => {
  expect(
    resolveEmbeddedPageHost("http://status.home", {
      desktopWebview: false,
      appProtocol: "http:",
    }).kind,
  ).toBe("iframe");
});

it("each new conversation gets a distinct reserved thread id", () => {
  const first = newPageAgentThreadId("status-board");
  const second = newPageAgentThreadId("status-board");
  expect(first).not.toBe(second);
  expect(first.startsWith("page-agent-status-board-")).toBe(true);
});
