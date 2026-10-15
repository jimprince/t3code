// @vitest-environment jsdom
import {
  buildSubheadRows,
  groupSubheadsByOwner,
} from "@t3tools/client-runtime/state/subheads-view";
import {
  NamedAgentName,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type Subhead,
  type SubheadRunRow,
} from "@t3tools/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const navigate = vi.hoisted(() => vi.fn());
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => navigate }));
vi.mock("../ui/sidebar", () => ({
  useSidebar: () => ({ isMobile: false, setOpenMobile: vi.fn() }),
}));

import { SubheadGroup } from "./SubheadRows";

const head = ThreadId.make("head");
const subhead = (name: string, overrides: Partial<Subhead> = {}): Subhead => ({
  id: `id-${name}`,
  kind: "virtual",
  version: 3,
  enabled: true,
  retiredAt: null,
  createdAt: "2026-10-10T10:00:00.000Z",
  updatedAt: "2026-10-10T10:00:00.000Z",
  name: NamedAgentName.make(name),
  projectId: ProjectId.make("project"),
  ownerThreadId: head,
  description: "",
  prompt: "Do it.",
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt" },
  runtimeMode: "approval-required",
  concurrency: 1,
  ...overrides,
});
let counter = 0;
const run = (name: string, overrides: Partial<SubheadRunRow> = {}): SubheadRunRow => {
  counter += 1;
  return {
    runId: `run-${counter}`,
    agentId: `id-${name}`,
    subheadName: NamedAgentName.make(name),
    requestId: `req-${counter}`,
    requestSummary: `Request ${counter}`,
    senderPrincipal: "owner",
    senderThreadId: null,
    templateVersion: 3,
    status: "completed",
    threadId: ThreadId.make(`thread-${counter}`),
    delivery: { id: `d-${counter}`, status: "delivered", messageId: "m", attempts: 1, error: null },
    blockedReason: null,
    terminationReason: null,
    createdAt: "2026-10-15T13:00:00.000Z",
    finishedAt: "2026-10-15T13:05:00.000Z",
    ...overrides,
  };
};

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  navigate.mockClear();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const renderGroup = (subheads: ReadonlyArray<Subhead>, runs: ReadonlyArray<SubheadRunRow>) => {
  const group = groupSubheadsByOwner(
    buildSubheadRows({ environmentId: "dev", subheads, runs }),
  ).get(head)!;
  act(() =>
    root.render(
      <SubheadGroup
        group={group}
        now={Date.parse("2026-10-15T13:41:00.000Z")}
        touch={false}
        selectedSubhead={null}
        lookup={{ title: (_, id) => (id === "alex" ? "Alex (UI)" : null) }}
        threadExists={(_, id) => id.startsWith("thread-")}
      />,
    ),
  );
};

describe("SubheadGroup", () => {
  it("shows a template row with its state, last outcome and nested open runs only", () => {
    renderGroup(
      [subhead("code-review")],
      [
        run("code-review", {
          status: "running",
          finishedAt: null,
          senderThreadId: ThreadId.make("alex"),
          requestSummary: "fix/cart-rounding",
        }),
        run("code-review", { status: "queued", finishedAt: null, requestSummary: "api-rename" }),
        run("code-review", { requestSummary: "old settled history" }),
      ],
    );
    const text = container.textContent ?? "";
    expect(text).toContain("code-review");
    expect(text).toContain("enabled · template, no live session");
    expect(text).toContain("2 open");
    expect(text).toContain("last ok");
    expect(text).toContain("Running: fix/cart-rounding");
    expect(text).toContain("from Alex (UI) · running");
    expect(text).toContain("Queued: api-rename");
    expect(text).toContain("waits for cap 1");
    // Settled history belongs to the detail page, not the sidebar.
    expect(text).not.toContain("old settled history");
    expect(text).not.toMatch(/live agent/i);
  });

  it("keeps retired subheads behind a toggle and marks disabled ones off", () => {
    renderGroup(
      [
        subhead("release-notes", { enabled: false }),
        subhead("old-notes", { retiredAt: "2026-10-12T00:00:00.000Z" }),
      ],
      [],
    );
    const text = container.textContent ?? "";
    expect(text).toContain("release-notes");
    expect(text).toContain("off");
    expect(text).toContain("disabled · template, no live session");
    expect(text).toContain("Show 1 retired subhead");
    expect(text).not.toContain("old-notes");
  });

  it("opens the run thread of a running run, and the page for a queued one", () => {
    renderGroup(
      [subhead("code-review")],
      [
        run("code-review", {
          status: "running",
          finishedAt: null,
          threadId: ThreadId.make("thread-running"),
        }),
        run("code-review", { status: "queued", finishedAt: null }),
      ],
    );
    const click = (label: string) =>
      act(() => container.querySelector<HTMLElement>(`[aria-label='${label}']`)!.click());
    click("Open running run of code-review");
    expect(navigate).toHaveBeenLastCalledWith(
      expect.objectContaining({ to: "/$environmentId/$threadId" }),
    );
    click("Open queued run of code-review");
    expect(navigate).toHaveBeenLastCalledWith({
      to: "/harness/subheads/$environmentId/$name",
      params: { environmentId: "dev", name: "code-review" },
    });
  });
});
