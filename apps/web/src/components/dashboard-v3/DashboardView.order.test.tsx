// @vitest-environment jsdom
import { mergeDashboardSnapshots } from "@t3tools/client-runtime/dashboard/merge";
import {
  DashboardSnapshot,
  EnvironmentId,
  ThreadId,
  type DashboardTask,
  type DashboardWorkstream,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Schema from "effect/Schema";
import { AsyncResult } from "effect/reactivity";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  data: null as unknown,
  now: 0,
  capable: true,
  failNext: false,
  /** Fails the next call of this command, whatever else is called before it. */
  failCommand: null as string | null,
  calls: [] as Array<{ command: string; value: Record<string, unknown> }>,
}));

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children: ReactNode }) => <a>{children}</a>,
  useNavigate: () => vi.fn(),
}));
vi.mock("../../state/liveRuntimeRequests", () => ({
  useLiveRuntimeRequests: () => ({ environments: new Set<string>(), pending: new Set<string>() }),
}));
vi.mock("../../state/dashboard", () => ({
  useDashboardData: () => ({
    data: state.data,
    revision: 1,
    failed: false,
    retry: undefined,
    olderEnvironments: [],
    snapshotSource: "live",
  }),
}));
vi.mock("../../state/entities", () => ({
  readProjects: () => [],
  readThreadShells: () => [],
  useProjects: () => [],
  useServerConfigs: () =>
    state.capable
      ? new Map([["env-1", { environment: { capabilities: { projectRequestOrder: true } } }]])
      : new Map(),
}));
vi.mock("../../state/environments", () => ({ useEnvironments: () => ({ environments: [] }) }));
vi.mock("../../state/forkSupervision", () => ({ useSupervisionMetadata: () => [] }));
vi.mock("../orchestrators/useOrchestratorThreads", () => ({
  useOrchestratorThreadShells: () => [],
}));
vi.mock("./useDecisionAnswers", () => ({
  useDecisionAnswers: () => ({
    records: new Map(),
    stateOf: () => null,
    reconcile: () => undefined,
    strip: () => ({ text: "" }),
  }),
}));
vi.mock("./prefs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./prefs")>()),
  useMinuteClock: () => state.now,
}));
// Every command records what the page asked the server and succeeds.
vi.mock("../../state/projectIssues", () => ({
  orderProjectRequest: { label: "order" },
  orderBatchProjectRequest: { label: "batch" },
  withdrawProjectRequest: { label: "withdraw" },
  updateProjectRequest: { label: "update" },
  fileProjectRequest: { label: "file" },
  settleProjectRequest: { label: "settle" },
}));
vi.mock("../../state/projectRoadmap", () => ({
  moveRoadmapItem: { label: "later" },
  saveRequestForLater: { label: "save-later" },
}));
// Uploads finish at once; each pasted image becomes the attachment "up-<its name>".
vi.mock("../../lib/attachmentUploadQueue", () => ({
  startAttachmentUpload: vi.fn(),
  releaseDraftAttachment: vi.fn(),
  awaitAttachmentUploads: () => Promise.resolve(),
  getUploadedAttachments: ({ images }: { images: ReadonlyArray<{ name: string; type: string }> }) =>
    images.map((image) => ({
      id: `up-${image.name}`,
      type: image.type,
      name: image.name,
      mimeType: "image/png",
      sizeBytes: 3,
    })),
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (command: { label: string }) => (value: { input: Record<string, unknown> }) => {
    state.calls.push({ command: command.label, value: value.input });
    if (state.failNext || state.failCommand === command.label) {
      state.failNext = false;
      state.failCommand = null;
      return Promise.resolve(AsyncResult.failure(Cause.fail(new Error("Gitea is down"))));
    }
    return Promise.resolve({
      _tag: "Success",
      value:
        command.label === "file"
          ? {
              request: { host: "git.test", repository: "brad/repo", number: 312, url: "u" },
              queued: false,
              notifiedThreadId: null,
            }
          : command.label === "withdraw"
            ? { withdrawn: true, notifiedThreadId: null }
            : { position: 1, rank: 1, workstream: null },
    });
  },
}));

import { DashboardView } from "./DashboardView";

const ENV = EnvironmentId.make("env-1");
const HEAD = ThreadId.make("root");
const NOW = "2026-10-14T12:00:00.000Z";
const decode = Schema.decodeUnknownSync(DashboardSnapshot);
const id = (n: number) => `issue:git.test/brad/repo#${n}`;
const ago = (hours: number) => new Date(Date.parse(NOW) - hours * 3_600_000).toISOString();

const task = (n: number, extra: Partial<DashboardTask> = {}) =>
  ({
    id: id(n),
    sourceId: "gitea:git.test/brad/repo",
    title: `Task ${n}`,
    url: null,
    threadId: null,
    workstreamId: "project:root:work",
    kind: "task",
    createdAt: ago(48),
    closedAt: null,
    status: "pending",
    progress: null,
    movement: { state: "unknown", doneDelta: null, windowMs: 0, fromAt: null, toAt: NOW },
    forecast: null,
    nextStep: null,
    attentionIds: [],
    ...extra,
  }) satisfies DashboardTask;
const epic = (n: number, taskIds: string[], extra: Partial<DashboardWorkstream> = {}) => ({
  id: id(n),
  title: `Epic ${n}`,
  url: `https://git.test/${n}`,
  taskIds,
  rank: n,
  ...extra,
});

function snapshot() {
  const tasks = [
    task(294, { workstreamId: id(300), partOf: 300, status: "working", rank: 10 }),
    task(295, { workstreamId: id(300), partOf: 300, rank: 100 }),
    task(296, { workstreamId: id(300), partOf: 300, rank: 200 }),
    task(282, { rank: 50 }),
    task(310, { createdAt: ago(1), placedBy: null }),
    task(311, { createdAt: ago(6) }),
  ];
  return decode({
    revision: 1,
    asOf: NOW,
    sources: [],
    releases: [],
    projects: [
      {
        planSource: "tracker",
        id: "project:root",
        rootThreadId: HEAD,
        parentId: null,
        title: "T3 Code",
        utility: false,
        omittedTaskCount: 0,
        workstreams: [
          epic(300, [id(294), id(295), id(296)]),
          { id: "project:root:work", title: "Unsorted", taskIds: [id(282), id(310), id(311)] },
        ],
        tasks,
        attention: [],
        sourceIds: [],
      },
    ],
  });
}

let root: Root;
let container: HTMLDivElement;

async function show() {
  state.data = mergeDashboardSnapshots([{ environmentId: ENV, snapshot: snapshot() }]);
  state.now = Date.parse(NOW);
  await act(() =>
    root.render(<DashboardView scope={{ kind: "project", environmentId: ENV, threadId: HEAD }} />),
  );
}
const text = () => container.textContent ?? "";
const button = (label: string) =>
  [...container.querySelectorAll("button")].find((b) => b.textContent?.trim() === label)!;
const field = () => container.querySelector("textarea")!;
async function type(value: string) {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
    setter.call(field(), value);
    field().dispatchEvent(new Event("input", { bubbles: true }));
  });
}
const press = (target: Element, init: KeyboardEventInit) =>
  act(async () => {
    target.dispatchEvent(
      new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }),
    );
  });

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  window.localStorage.clear();
  state.calls = [];
  state.capable = true;
  state.failNext = false;
  state.failCommand = null;
  URL.createObjectURL = () => "blob:preview";
  URL.revokeObjectURL = () => undefined;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
});

describe("New, not ordered", () => {
  it("lists unranked asks newest first and marks only those filed in the last four hours", async () => {
    await show();
    const rows = [...container.querySelectorAll('[data-testid="new-row"]')];
    expect(rows.map((row) => /#(\d{3})/.exec(row.textContent!)![1])).toEqual(["310", "311"]);
    expect(rows[0]!.querySelector('[data-testid="new-mark"]')?.getAttribute("aria-label")).toBe(
      "New, not placed yet",
    );
    expect(rows[1]!.querySelector('[data-testid="new-mark"]')).toBeNull();
  });

  it("names who placed an item that is already in the queue", async () => {
    state.capable = true;
    const original = snapshot();
    const edited = {
      ...original,
      projects: original.projects.map((project) => ({
        ...project,
        tasks: project.tasks.map((t) =>
          t.id === id(295)
            ? { ...t, createdAt: ago(1), placedBy: { kind: "agent" as const, name: "Product" } }
            : t,
        ),
      })),
    };
    state.data = mergeDashboardSnapshots([{ environmentId: ENV, snapshot: edited }]);
    state.now = Date.parse(NOW);
    await act(() =>
      root.render(
        <DashboardView scope={{ kind: "project", environmentId: ENV, threadId: HEAD }} />,
      ),
    );
    const marks = [...container.querySelectorAll('[data-testid="new-mark"]')].map((m) =>
      m.getAttribute("aria-label"),
    );
    expect(marks).toContain("New, placed by Product");
  });

  it("Do next asks the server to place the item at the top, as Brad", async () => {
    await show();
    await act(async () => button("Do next").click());
    expect(state.calls).toEqual([
      {
        command: "order",
        value: { threadId: HEAD, reference: "310", place: { to: "top" }, actor: "brad" },
      },
    ]);
    expect(text()).toContain("Saved: #310 is 1st in Other work.");
  });

  it("does not show without the server capability", async () => {
    state.capable = false;
    await show();
    expect(container.querySelector('[data-testid="new-block"]')).toBeNull();
    expect(container.querySelector('[data-testid="dashboard-request-line"]')).toBeNull();
    expect(container.querySelector('[data-testid="queued-row"]')).toBeNull();
  });
});

describe("the ordered Plan", () => {
  it("numbers queued rows from 1 and leaves started work unnumbered above them", async () => {
    await show();
    const queued = [...container.querySelectorAll('[data-testid="queued-row"]')].map((row) =>
      row.getAttribute("aria-label"),
    );
    expect(queued).toEqual(["1. Task 295", "2. Task 296", "1. Task 282"]);
    expect(text()).toContain("Next, in order");
    expect(text().indexOf("Task 294")).toBeLessThan(text().indexOf("Task 295"));
  });

  it("Alt+Down moves the focused row after its neighbour", async () => {
    await show();
    const row = container.querySelector('[data-testid="queued-row"]')!;
    await press(row, { key: "ArrowDown", altKey: true });
    expect(state.calls[0]).toEqual({
      command: "order",
      value: {
        threadId: HEAD,
        reference: "295",
        place: { to: "after", reference: "296" },
        actor: "brad",
      },
    });
  });

  it("N does a focused row next within its workstream", async () => {
    await show();
    const row = container.querySelectorAll('[data-testid="queued-row"]')[1]!;
    await press(row, { key: "n" });
    expect(state.calls[0]!.value).toMatchObject({ reference: "296", place: { to: "top" } });
  });
});

describe("the request line", () => {
  it("Enter files last and Cmd+Enter files next, with Brad's words and actor", async () => {
    await show();
    await type("Widen the plan");
    await press(field(), { key: "Enter" });
    await type("Narrow the plan");
    await press(field(), { key: "Enter", metaKey: true });
    const filings = state.calls.filter((call) => call.command === "file");
    expect(filings.map((call) => call.value.place)).toEqual([{ to: "bottom" }, { to: "top" }]);
    expect(filings[0]!.value).toMatchObject({
      threadId: HEAD,
      title: "Widen the plan",
      kind: "task",
      actor: "brad",
    });
    expect(text()).toContain("Filed #312 task, next in Other work.");
  });

  it("selects Bug from a Bug: lead and keeps the words", async () => {
    await show();
    await type("Bug: the drag drops one row up");
    await press(field(), { key: "Enter" });
    expect(state.calls[0]!.value).toMatchObject({
      title: "Bug: the drag drops one row up",
      bug: true,
      kind: "task",
    });
  });

  it("files into the chosen workstream", async () => {
    await show();
    const select = container.querySelector<HTMLSelectElement>('select[aria-label="Workstream"]')!;
    await act(async () => {
      select.value = "300";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await type("Add a thing");
    await press(field(), { key: "Enter" });
    expect(state.calls[0]!.value).toMatchObject({ partOf: 300 });
  });

  it("keeps the words and says why when the filing fails, then retries the same filing", async () => {
    await show();
    await type("Do not lose me");
    state.failNext = true;
    await press(field(), { key: "Enter" });
    expect(field().value).toBe("Do not lose me");
    expect(text()).toContain("Not filed: Gitea is down");
    await press(field(), { key: "Enter" });
    const [first, second] = state.calls.filter((call) => call.command === "file");
    expect(second!.value.messageId).toBe(first!.value.messageId);
    expect(field().value).toBe("");
  });
});

/** The snapshot with two more queued rows in Other work, 283 then 284 after 282. */
function withQueuedOther() {
  const base = snapshot();
  return {
    ...base,
    projects: base.projects.map((project) => ({
      ...project,
      tasks: [...project.tasks, task(283, { rank: 60 }), task(284, { rank: 70 })],
      workstreams: project.workstreams.map((workstream) =>
        workstream.id === "project:root:work"
          ? { ...workstream, taskIds: [...workstream.taskIds, id(283), id(284)] }
          : workstream,
      ),
    })),
  };
}
async function showSnapshot(
  data: ReturnType<typeof snapshot>,
  scope: Parameters<typeof DashboardView>[0]["scope"] = {
    kind: "project",
    environmentId: ENV,
    threadId: HEAD,
  },
) {
  state.data = mergeDashboardSnapshots([{ environmentId: ENV, snapshot: data }]);
  state.now = Date.parse(NOW);
  await act(() => root.render(<DashboardView scope={scope} />));
}
const queuedLabels = () =>
  [...container.querySelectorAll('[data-testid="queued-row"]')].map((row) =>
    row.getAttribute("aria-label"),
  );
const rowOf = (title: string) =>
  [...container.querySelectorAll('[data-testid="queued-row"]')].find((row) =>
    row.getAttribute("aria-label")?.endsWith(title),
  )!;

describe("a move made before the snapshot catches up", () => {
  it("renumbers at once, so a second Alt+Up reads the list the first one made", async () => {
    await showSnapshot(withQueuedOther());
    await press(rowOf("Task 284"), { key: "ArrowUp", altKey: true });
    expect(queuedLabels().slice(2)).toEqual(["1. Task 282", "2. Task 284", "3. Task 283"]);
    await press(rowOf("Task 284"), { key: "ArrowUp", altKey: true });
    // The snapshot never changed here, as when the refresh is still on its way.
    expect(queuedLabels().slice(2)).toEqual(["1. Task 284", "2. Task 282", "3. Task 283"]);
    expect(state.calls.map((call) => call.value.place)).toEqual([
      { to: "before", reference: "283" },
      { to: "before", reference: "282" },
    ]);
  });

  it("returns the row to where it was when the write fails, and says so by the row", async () => {
    await showSnapshot(withQueuedOther());
    state.failCommand = "order";
    await press(rowOf("Task 284"), { key: "ArrowUp", altKey: true });
    expect(queuedLabels().slice(2)).toEqual(["1. Task 282", "2. Task 283", "3. Task 284"]);
    const alert = container.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain("Could not save: Gitea is down");
  });

  it("puts the epic back when ordering fails after the epic changed", async () => {
    await showSnapshot(withQueuedOther());
    state.failCommand = "order";
    await dragTask("Task 282", "Task 295");
    expect(state.calls.map((call) => call.command)).toEqual(["update", "order", "update"]);
    expect(state.calls[0]!.value).toMatchObject({ reference: "282", partOf: 300 });
    expect(state.calls[2]!.value).toMatchObject({ reference: "282", partOf: null });
  });
});

/** Drives the row handlers with the events a drag fires, one render apart. */
async function dragTask(from: string, to: string) {
  const data = { setData: () => undefined, setDragImage: () => undefined, effectAllowed: "" };
  const handle = rowOf(from).querySelector('[draggable="true"]')!;
  const target = rowOf(to);
  const send = async (el: Element, type: string) => {
    const event = new Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(event, "dataTransfer", { value: { ...data, types: [] } });
    Object.defineProperty(event, "clientY", { value: 0 });
    await act(async () => {
      el.dispatchEvent(event);
    });
    return event.defaultPrevented;
  };
  await send(handle, "dragstart");
  const accepted = await send(target, "dragover");
  if (accepted) await send(target, "drop");
  return accepted;
}

describe("Home", () => {
  it("numbers rows by their place in their own workstream", async () => {
    await showSnapshot(withQueuedOther(), { kind: "home" });
    expect(queuedLabels()).toEqual(["1. Task 295", "2. Task 296", "1. Task 282"]);
  });

  it("refuses a drop into another workstream, and accepts one inside the same", async () => {
    await showSnapshot(withQueuedOther(), { kind: "home" });
    expect(await dragTask("Task 282", "Task 295")).toBe(false);
    expect(state.calls).toEqual([]);
    expect(await dragTask("Task 295", "Task 296")).toBe(true);
    expect(state.calls.map((call) => call.command)).toEqual(["order"]);
  });
});

describe("a project with no tracker", () => {
  it("keeps the old request box instead of a line that cannot file", async () => {
    const base = snapshot();
    await showSnapshot({
      ...base,
      projects: base.projects.map((project) => ({ ...project, planSource: "briefing" as const })),
    });
    expect(container.querySelector('[data-testid="dashboard-request-line"]')).toBeNull();
    expect(container.querySelector('[data-testid="new-block"]')).toBeNull();
  });
});

describe("images on the request line", () => {
  const png = (name: string) => new File([new Uint8Array([1, 2, 3])], name, { type: "image/png" });
  const paste = (...files: File[]) =>
    act(async () => {
      const event = new Event("paste", { bubbles: true, cancelable: true });
      Object.defineProperty(event, "clipboardData", { value: { files } });
      field().dispatchEvent(event);
    });

  it("files a pasted image with the words, and again as an image-only filing", async () => {
    await show();
    await paste(png("a.png"));
    expect(container.querySelector('img[alt="a.png"]')).not.toBeNull();
    await type("See the screenshot");
    await press(field(), { key: "Enter" });
    expect(state.calls[0]!.value.attachments).toEqual([
      { id: "up-a.png", type: "image", name: "a.png", mimeType: "image/png", sizeBytes: 3 },
    ]);
    expect(container.querySelector("img")).toBeNull();

    await paste(png("b.png"));
    await press(field(), { key: "Enter" });
    expect(state.calls[1]!.value).toMatchObject({
      title: "Request with images",
      attachments: [{ id: "up-b.png" }],
    });
  });

  it("removes a thumbnail, and a changed set of images is a new filing", async () => {
    await show();
    await type("Two shots");
    await paste(png("a.png"));
    state.failNext = true;
    await press(field(), { key: "Enter" });
    expect(text()).toContain("Not filed: Gitea is down");
    await paste(png("b.png"));
    await press(field(), { key: "Enter" });
    const [failed, retried] = state.calls.filter((call) => call.command === "file");
    expect(retried!.value.messageId).not.toBe(failed!.value.messageId);
    expect(retried!.value.attachments).toHaveLength(2);
    expect(container.querySelector("img")).toBeNull();

    await paste(png("c.png"));
    await act(async () =>
      container.querySelector<HTMLButtonElement>('button[aria-label="Remove c.png"]')!.click(),
    );
    expect(container.querySelector("img")).toBeNull();
  });
});

describe("the request line keeps what the old box had", () => {
  it("keeps the collapsed line short and shows the key hints on focus", async () => {
    await show();
    // The long placeholder wrapped to two lines beside the chat panel; the hints wait for focus.
    expect(field().placeholder).toBe("New request");
    expect(text()).not.toContain("files it last");
    await act(async () => field().focus());
    expect(text()).toContain("Enter files it last,");
    expect(text()).toContain("files it next");
    // Typing folds the starters away but the hints stay for the typed line.
    await type("Typed words");
    expect(text()).not.toContain("Bug report");
    expect(text()).toContain("files it last");
  });

  it("shows the starters on focus and puts one in the line", async () => {
    await show();
    expect(text()).not.toContain("Bug report");
    await act(async () => field().focus());
    await act(async () => button("Bug report").click());
    expect(field().value).toBe("Bug: ");
    expect(container.querySelector('button[aria-pressed="true"]')?.textContent).toBe("Bug");
  });

  it("saves the words for later without filing them", async () => {
    await show();
    await type("Maybe someday");
    await act(async () => button("Save for later").click());
    expect(state.calls).toEqual([
      {
        command: "save-later",
        value: {
          threadId: HEAD,
          title: "Maybe someday",
          kind: "task",
          detail: "Maybe someday",
          park: true,
        },
      },
    ]);
    expect(field().value).toBe("");
  });

  it("withdraws a filing on Undo and puts the words back", async () => {
    await show();
    await type("Typo in my request");
    await press(field(), { key: "Enter" });
    expect(field().value).toBe("");
    await act(async () => button("Undo").click());
    expect(state.calls.at(-1)).toEqual({
      command: "withdraw",
      value: { threadId: HEAD, reference: "312", actor: "brad" },
    });
    expect(field().value).toBe("Typo in my request");
  });
});
