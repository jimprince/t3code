// @vitest-environment jsdom
import {
  EnvironmentId,
  NamedAgentName,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type Subhead,
} from "@t3tools/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const page = vi.hoisted(() => ({
  current: { subhead: null as unknown, runs: [] as unknown[], loading: false, error: null, refresh: () => {} },
}));
const call = vi.hoisted(() => vi.fn());
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vi.fn() }));
vi.mock("../../state/subheads", () => ({ useSubheadPage: () => page.current }));
vi.mock("../../state/entities", () => ({ useProjects: () => [], useThreadShells: () => [] }));
vi.mock("../../hooks/useNowMinute", () => ({ useNowMinute: () => "2026-10-16T09:00" }));
vi.mock("../sidebarMode", () => ({ useSidebarMode: () => ["harness", vi.fn()] }));
vi.mock("../ui/sidebar", () => ({
  SidebarInset: ({ children }: { children: unknown }) => <div>{children as never}</div>,
  useSidebar: () => ({ isMobile: false, open: true, setOpen: vi.fn(), setOpenMobile: vi.fn() }),
}));
vi.mock("./useSubheadCommand", () => ({ useSubheadCall: () => call }));

import { SubheadPage } from "./SubheadPage";

const subhead = (overrides: Partial<Subhead> = {}): Subhead => ({
  id: "id-review",
  kind: "virtual",
  version: 7,
  enabled: true,
  retiredAt: null,
  createdAt: "2026-10-10T10:00:00.000Z",
  updatedAt: "2026-10-10T10:00:00.000Z",
  name: NamedAgentName.make("code-review"),
  projectId: ProjectId.make("project"),
  ownerThreadId: ThreadId.make("head"),
  description: "Reviews one diff",
  prompt: "Review exactly one diff.",
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt" },
  runtimeMode: "approval-required",
  concurrency: 1,
  createdBy: "cli-credential",
  ...overrides,
});

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  call.mockReset();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const render = (entry: Subhead) => {
  page.current = { ...page.current, subhead: entry, runs: [] };
  act(() =>
    root.render(<SubheadPage environmentId={EnvironmentId.make("dev")} name="code-review" />),
  );
};
const button = (label: string) =>
  [...container.querySelectorAll("button")].find((entry) => entry.textContent === label)!;
const setValue = (element: HTMLInputElement | HTMLTextAreaElement, value: string) =>
  act(() => {
    const prototype =
      element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });

describe("SubheadPage", () => {
  it("keeps an open draft and says so when a newer version is read while editing", async () => {
    render(subhead());
    act(() => button("Edit").click());
    const description = container.querySelector<HTMLInputElement>("input")!;
    setValue(description, "My unsaved rewrite");
    expect(container.textContent).toContain("Editing v7");
    // The 15 s poll reads v8, which someone else saved.
    render(subhead({ version: 8, prompt: "Their prompt" }));
    expect(container.querySelector<HTMLInputElement>("input")!.value).toBe("My unsaved rewrite");
    expect(container.textContent).toContain("v8 was saved while you were editing v7");
    expect(container.textContent).toContain("Editing v7");
    // Saving is still sent against the version the draft was made from, and the server refuses it.
    call.mockResolvedValue({
      ok: false,
      message: "Template version conflict: expected 7, current 8.",
    });
    await act(async () => button("Save as new version").click());
    expect(call).toHaveBeenCalledWith(expect.objectContaining({ expectedVersion: 7 }));
    expect(container.textContent).toContain("Template version conflict: expected 7, current 8.");
    // The refusal also survives the next poll instead of being wiped by a remount.
    render(subhead({ version: 8, prompt: "Their prompt" }));
    expect(container.textContent).toContain("Template version conflict: expected 7, current 8.");
    expect(container.querySelector<HTMLInputElement>("input")!.value).toBe("My unsaved rewrite");
    // Reload restarts the form from v8 and drops the draft on purpose.
    act(() => button("Reload v8 and drop the draft").click());
    expect(container.textContent).toContain("Editing v8");
    expect(container.querySelector<HTMLInputElement>("input")!.value).toBe("Reviews one diff");
  });

  it("disables edit and the state buttons, with the reason, for a session that may not change it", () => {
    render(subhead({ callerMayChange: false }));
    expect(container.textContent).toContain(
      "Only cli-credential or an administrator may change this subhead.",
    );
    for (const label of ["Edit", "Disable", "Retire"])
      expect(button(label).hasAttribute("disabled")).toBe(true);
    // Sending is open to every authorized session.
    expect(button("Send").hasAttribute("disabled")).toBe(false);
  });

  it("leaves the buttons on when the server says this session may change it, or does not say", () => {
    for (const callerMayChange of [true, undefined]) {
      render(subhead(callerMayChange === undefined ? {} : { callerMayChange }));
      for (const label of ["Edit", "Disable", "Retire"])
        expect(button(label).hasAttribute("disabled")).toBe(false);
      expect(container.textContent).not.toContain("may change this subhead");
    }
  });
});
