// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  source: "live" as "live" | "cached",
  threads: new Set<string>(),
  records: new Map<string, { row: { key: string; attention: { title: string } } }>(),
}));

vi.mock("../../state/dashboard", () => ({
  useDashboardData: () => ({
    snapshotSource: state.source,
    data: {
      projects: [
        {
          key: "env|p",
          environmentId: "env",
          project: {
            title: "Dashboard",
            attention: [
              {
                id: "stale",
                title: "Resolved by Product three minutes ago",
                kind: "question",
                requestId: "req-old",
                threadId: "t0",
                options: [],
                priority: 2,
              },
              {
                id: "live",
                title: "Still waiting on a reply",
                kind: "question",
                requestId: "req-live",
                threadId: "t1",
                options: [],
                priority: 1,
              },
              {
                id: "second",
                title: "Second ask on the same thread",
                kind: "approval",
                requestId: "req-second",
                threadId: "t1",
                options: [],
                priority: 4,
              },
              {
                id: "issue",
                title: "Tracker decision",
                kind: "decision",
                requestId: null,
                threadId: null,
                options: [],
                priority: 3,
              },
            ],
          },
        },
      ],
    },
  }),
}));
vi.mock("../../state/liveRuntimeRequests", () => ({
  useLiveRuntimeRequests: () => ({ environments: new Set(["env"]), threads: state.threads }),
}));
vi.mock("../dashboard-v3/prefs", () => ({ useMinuteClock: () => 0 }));
vi.mock("../dashboard-v3/useDecisionAnswers", () => ({
  useDecisionAnswers: () => ({ records: state.records, stateOf: () => null, reconcile: vi.fn() }),
}));
vi.mock("../dashboard-v3/decisions", () => ({
  DecisionCard: ({ row }: { row: { attention: { title: string } } }) => (
    <div data-testid="card">{row.attention.title}</div>
  ),
}));

import { CosDecisionPin } from "./CosDecisionPin";

let root: Root;
let container: HTMLDivElement;

const shown = async () => {
  await act(() =>
    root.render(<CosDecisionPin environmentId={"env" as never} id="pin" open onClose={vi.fn()} />),
  );
  return [...container.querySelectorAll('[data-testid="card"]')].map((card) => card.textContent);
};

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.source = "live";
  state.threads = new Set(["env|t1"]);
  state.records = new Map();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("the tray pin only shows what is still pending (#303)", () => {
  it("drops a thread question its thread no longer lists, and keeps the rest", async () => {
    const titles = await shown();
    expect(titles).toContain("Still waiting on a reply");
    expect(titles).not.toContain("Resolved by Product three minutes ago");
  });

  it("keeps a second pending ask on a thread whose shell lists only one request", async () => {
    await shown();
    // The pin lists one card at a time under "1 of N": the issue item and both asks are counted.
    expect(container.textContent).toContain("1 of 3");
  });

  it("shows no thread question from a snapshot stored on this device", async () => {
    state.source = "cached";
    const titles = await shown();
    expect(titles).toEqual(["Tracker decision"]);
  });
});

describe("the tray pin keeps an answered decision on screen", () => {
  it("stays on the answered card, with its receipt, after the snapshot drops it", async () => {
    // "Tracker decision" is not a runtime ask, so it is listed whatever the pending requests say.
    state.threads = new Set(["env|t1"]);
    const first = await shown();
    expect(first[0]).toBe("Still waiting on a reply");
    // The ask is answered: its thread no longer lists it, and the answer record carries the card.
    state.threads = new Set();
    state.records = new Map([
      [
        "env|p|live",
        { row: { key: "env|p|live", attention: { title: "Still waiting on a reply" } } },
      ],
    ]);
    const after = await shown();
    expect(after).toEqual(["Still waiting on a reply"]);
  });
});
