import { ProviderInstanceId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildPageAgentPreamble,
  deletePageAgentConversation,
  ensurePageAgentTab,
  isPageAgentRunning,
  newPageAgentConversation,
  openPageAgentConversation,
  PAGE_AGENT_IDLE_RESTART_MS,
  resolvePageAgentModelSelection,
  resumePreviousPageAgentConversation,
  stripPageAgentPreamble,
} from "./pageAgent.logic";

const NOW = Date.parse("2026-10-02T12:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();

describe("page agent conversation lifecycle", () => {
  it("starts a conversation on first open", () => {
    expect(openPageAgentConversation({ stored: null, now: NOW, newId: "b" })).toEqual({
      conversations: { current: "b", previous: null, lastSentAt: null },
      discarded: null,
    });
  });

  it("continues a recently used conversation and an unsent one", () => {
    const recent = { current: "a", previous: null, lastSentAt: iso(NOW - 60_000) };
    expect(openPageAgentConversation({ stored: recent, now: NOW, newId: "b" })).toBeNull();
    const unsent = { current: "a", previous: "z", lastSentAt: null };
    expect(openPageAgentConversation({ stored: unsent, now: NOW, newId: "b" })).toBeNull();
  });

  it("starts fresh after the idle window, keeping one previous and discarding the older", () => {
    const stale = {
      current: "a",
      previous: "z",
      lastSentAt: iso(NOW - PAGE_AGENT_IDLE_RESTART_MS),
    };
    expect(openPageAgentConversation({ stored: stale, now: NOW, newId: "b" })).toEqual({
      conversations: { current: "b", previous: "a", lastSentAt: null },
      discarded: "z",
    });
  });

  it("replaces an unsent conversation instead of keeping it as previous", () => {
    expect(
      newPageAgentConversation({ current: "a", previous: "z", lastSentAt: null }, "b"),
    ).toEqual({
      conversations: { current: "b", previous: "z", lastSentAt: null },
      discarded: null,
    });
  });

  it("resume swaps the two so the newer conversation stays reachable", () => {
    const now = iso(NOW);
    expect(
      resumePreviousPageAgentConversation(
        { current: "b", previous: "a", lastSentAt: iso(NOW - 1) },
        now,
      ),
    ).toEqual({ current: "a", previous: "b", lastSentAt: now });
    expect(
      resumePreviousPageAgentConversation({ current: "b", previous: "a", lastSentAt: null }, now),
    ).toEqual({ current: "a", previous: null, lastSentAt: now });
    expect(
      resumePreviousPageAgentConversation({ current: "b", previous: null, lastSentAt: now }, now),
    ).toBeNull();
  });

  it("delete promotes the previous conversation, or starts fresh", () => {
    const now = iso(NOW);
    expect(
      deletePageAgentConversation({ current: "b", previous: "a", lastSentAt: now }, "c", now),
    ).toEqual({ current: "a", previous: null, lastSentAt: now });
    expect(
      deletePageAgentConversation({ current: "b", previous: null, lastSentAt: now }, "c", now),
    ).toEqual({ current: "c", previous: null, lastSentAt: null });
  });
});

describe("resolvePageAgentModelSelection", () => {
  const entry = (instanceId: string, driverKind: string, slugs: string[], enabled = true) => ({
    instanceId: ProviderInstanceId.make(instanceId),
    driverKind,
    enabled,
    isAvailable: true,
    models: slugs.map((slug) => ({ slug })),
  });
  const fallback = { instanceId: ProviderInstanceId.make("claudeAgent"), model: "claude-opus-5-5" };

  it("prefers the remembered tray model while its instance still offers it", () => {
    const remembered = { instanceId: ProviderInstanceId.make("codex_gmail"), model: "gpt-6-luna" };
    const entries = [entry("codex_gmail", "codex", ["gpt-6.1-sol", "gpt-6-luna"])];
    expect(resolvePageAgentModelSelection({ remembered, entries, fallback })).toBe(remembered);
    expect(
      resolvePageAgentModelSelection({
        remembered,
        entries: [entry("codex_gmail", "codex", ["gpt-6.1-sol", "gpt-6-luna"], false)],
        fallback,
      }),
    ).toBe(fallback);
  });

  it("defaults to GPT-6.1 Sol on the fast tier from the first enabled Codex instance", () => {
    const entries = [
      entry("claudeAgent", "claudeAgent", ["claude-opus-5-5"]),
      entry("codex", "codex", ["gpt-6.1-sol"], false),
      entry("codex_gmail", "codex", ["gpt-6.1-sol"]),
    ];
    expect(resolvePageAgentModelSelection({ remembered: null, entries, fallback })).toEqual({
      instanceId: "codex_gmail",
      model: "gpt-6.1-sol",
      options: [{ id: "serviceTier", value: "fast" }],
    });
  });

  it("falls back to the general default without a Codex instance", () => {
    const entries = [entry("claudeAgent", "claudeAgent", ["claude-opus-5-5"])];
    expect(resolvePageAgentModelSelection({ remembered: null, entries, fallback })).toBe(fallback);
  });
});

describe("page agent preamble", () => {
  it("round-trips through the tray's message rendering", () => {
    const preamble = buildPageAgentPreamble({ name: "Paperclip", url: "https://example.test" });
    expect(preamble).toContain('"Paperclip" (https://example.test)');
    expect(stripPageAgentPreamble(`${preamble}Open the Inbox tab`)).toBe("Open the Inbox tab");
    expect(stripPageAgentPreamble("plain message")).toBe("plain message");
  });
});

describe("isPageAgentRunning", () => {
  const turn = (state: "running" | "completed") =>
    ({
      turnId: "t",
      state,
      requestedAt: "",
      startedAt: null,
      completedAt: null,
      assistantMessageId: null,
    }) as never;
  it("treats a running turn or an active provider turn as in flight", () => {
    expect(isPageAgentRunning({ latestTurn: turn("running"), session: null })).toBe(true);
    expect(
      isPageAgentRunning({
        latestTurn: turn("completed"),
        session: { status: "ready", activeTurnId: "t2" } as never,
      }),
    ).toBe(true);
    expect(
      isPageAgentRunning({
        latestTurn: turn("completed"),
        session: { status: "ready", activeTurnId: null } as never,
      }),
    ).toBe(false);
  });
});

describe("ensurePageAgentTab", () => {
  const harness = (options: { serverTabs: string[]; listOk?: boolean; openFails?: boolean }) => {
    const tabs = new Set<string>();
    const calls: string[] = [];
    let cancelled = false;
    const deps = {
      syncFromServer: async () => {
        calls.push("sync");
        if (options.listOk === false) return false;
        for (const tab of options.serverTabs) tabs.add(tab);
        return true;
      },
      hasTab: () => tabs.size > 0,
      openTab: async () => {
        calls.push("open");
        if (options.openFails) return null;
        tabs.add("tab_new");
        return "tab_new";
      },
      closeTab: (tabId: string) => {
        calls.push(`close:${tabId}`);
        tabs.delete(tabId);
      },
      isCancelled: () => cancelled,
    };
    return { deps, calls, tabs, cancel: () => (cancelled = true) };
  };

  it("opens the page after the server reports no tab, without waiting on a passive subscription", async () => {
    const { deps, calls } = harness({ serverTabs: [] });
    await expect(ensurePageAgentTab(deps)).resolves.toBe("opened");
    expect(calls).toEqual(["sync", "open"]);
  });

  it("reuses a tab the server still holds, so a reload does not add a second guest", async () => {
    const { deps, calls } = harness({ serverTabs: ["tab_1"] });
    await expect(ensurePageAgentTab(deps)).resolves.toBe("reused");
    expect(calls).toEqual(["sync"]);
  });

  it("still opens when the server list cannot be read", async () => {
    const { deps, calls } = harness({ serverTabs: [], listOk: false });
    await expect(ensurePageAgentTab(deps)).resolves.toBe("opened");
    expect(calls).toEqual(["sync", "open"]);
  });

  it("closes a tab whose open finished after the page view went away", async () => {
    const h = harness({ serverTabs: [] });
    const openTab = h.deps.openTab;
    const result = ensurePageAgentTab({
      ...h.deps,
      openTab: async () => {
        const tabId = await openTab();
        h.cancel();
        return tabId;
      },
    });
    await expect(result).resolves.toBe("cancelled");
    expect(h.calls).toEqual(["sync", "open", "close:tab_new"]);
    expect(h.tabs.size).toBe(0);
  });

  it("does not open once the view is gone before the list returns", async () => {
    const h = harness({ serverTabs: [] });
    h.cancel();
    await expect(ensurePageAgentTab(h.deps)).resolves.toBe("cancelled");
    expect(h.calls).toEqual(["sync"]);
  });
});
