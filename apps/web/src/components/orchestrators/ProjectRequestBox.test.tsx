// @vitest-environment jsdom
import type { OrchestratorSummary } from "@t3tools/client-runtime/state/orchestrators";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

// The wire and the data hooks are replaced; the request box itself runs as shipped.
vi.mock("../../state/projectIssues", () => ({
  startRequestIntake: {},
  submitProjectRequest: {},
}));
vi.mock("../../state/projectRoadmap", () => ({ saveRequestForLater: {} }));
vi.mock("../../state/threads", () => ({ threadEnvironment: { archive: {} } }));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));
vi.mock("./ProjectRequestsSection", () => ({ useProjectRequests: () => ({}) }));
vi.mock("./sendToOrchestrator", () => ({
  useSendToOrchestrator: () => vi.fn(),
  useSendToThread: () => vi.fn(),
}));
vi.mock("./TaskLink", () => ({ TaskTitle: () => null }));

import { ProjectRequestBox, REQUEST_QUICK_ACTIONS } from "./ProjectRequestBox";

const summary = { root: { environmentId: "env-1", id: "head", title: "T3 Orchestrator" } };

let root: Root;
let container: HTMLDivElement;

const render = () =>
  act(() =>
    root.render(
      <ProjectRequestBox
        summary={summary as unknown as OrchestratorSummary}
        quickActions={REQUEST_QUICK_ACTIONS}
        placeholder="New request to T3 Orchestrator"
      />,
    ),
  );
const line = () => container.querySelector<HTMLInputElement>("input[aria-label='New request']");
const composer = () =>
  container.querySelector<HTMLTextAreaElement>("textarea[aria-label='New request']");
const chip = (label: string) =>
  [...container.querySelectorAll("button")].find((button) => button.textContent === label);
const chips = () => REQUEST_QUICK_ACTIONS.filter((action) => chip(action.label));

async function type(text: string) {
  const field = composer()!;
  await act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(field, text);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
});

describe("ProjectRequestBox", () => {
  it("is one compact line by default: a placeholder, no composer, no chips, no buttons", async () => {
    await render();
    expect(line()?.placeholder).toBe("New request to T3 Orchestrator");
    expect(composer()).toBeNull();
    expect(chips()).toHaveLength(0);
    expect(container.querySelectorAll("button")).toHaveLength(0);
  });

  it("opens the composer with the quick actions when the line is focused", async () => {
    await render();
    await act(() => line()!.focus());
    expect(composer()).not.toBeNull();
    expect(line()).toBeNull();
    expect(chips()).toHaveLength(REQUEST_QUICK_ACTIONS.length);
    expect(document.activeElement).toBe(composer());
  });

  it("opens when the line is clicked into by a pointer", async () => {
    await render();
    // A pointer click focuses the field first; the box opens on that focus.
    await act(() => {
      line()!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
      line()!.focus();
      line()!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(composer()).not.toBeNull();
    expect(chips()).toHaveLength(REQUEST_QUICK_ACTIONS.length);
  });

  it("keeps typed text and stays open after the box loses focus, without the quick actions", async () => {
    await render();
    await act(() => line()!.focus());
    await type("Bug: the plan clips titles");
    await act(() => composer()!.blur());
    expect(composer()?.value).toBe("Bug: the plan clips titles");
    expect(line()).toBeNull();
    expect(chips()).toHaveLength(0);
  });

  it("folds back to the single line when it loses focus empty", async () => {
    await render();
    await act(() => line()!.focus());
    expect(composer()).not.toBeNull();
    await act(() => composer()!.blur());
    expect(composer()).toBeNull();
    expect(line()).not.toBeNull();
    expect(chips()).toHaveLength(0);
  });

  it("folds back after text is typed and then deleted and the box is left", async () => {
    await render();
    await act(() => line()!.focus());
    await type("x");
    await type("");
    await act(() => composer()!.blur());
    expect(composer()).toBeNull();
    expect(line()).not.toBeNull();
  });

  it("keeps the box open and the quick actions present when focus moves to a quick action (Tab)", async () => {
    await render();
    await act(() => line()!.focus());
    // Tab from the empty composer lands on the first chip: focus leaves the textarea but not the box.
    await act(() => chip("Bug report")!.focus());
    expect(composer()).not.toBeNull();
    expect(chips()).toHaveLength(REQUEST_QUICK_ACTIONS.length);
    expect(document.activeElement).toBe(chip("Bug report"));
    // And on to the next chip.
    await act(() => chip("Feature request")!.focus());
    expect(chips()).toHaveLength(REQUEST_QUICK_ACTIONS.length);
  });

  it("folds an empty box when focus leaves it for something outside, from the composer or a chip", async () => {
    const outside = document.createElement("button");
    document.body.append(outside);
    await render();
    await act(() => line()!.focus());
    await act(() => outside.focus());
    expect(composer()).toBeNull();
    expect(line()).not.toBeNull();
    await act(() => line()!.focus());
    await act(() => chip("Bug report")!.focus());
    await act(() => outside.focus());
    expect(composer()).toBeNull();
    expect(chips()).toHaveLength(0);
    outside.remove();
  });

  it("a quick action puts the caret at the end once and does not move it on a later focus", async () => {
    await render();
    await act(() => line()!.focus());
    await act(() => chip("Bug report")!.click());
    expect(composer()!.selectionStart).toBe("Bug: ".length);
    // The user clicks back into the middle of the text: nothing may pull the caret to the end.
    await act(() => composer()!.blur());
    composer()!.setSelectionRange(2, 2);
    await act(() => composer()!.focus());
    expect(composer()!.selectionStart).toBe(2);
  });

  it("a quick action fills the box and holds focus, so the click cannot fold it", async () => {
    await render();
    await act(() => line()!.focus());
    const bug = chip("Bug report")!;
    // The press must not move focus off the composer: that blur would fold it before the click.
    const press = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
    await act(() => bug.dispatchEvent(press));
    expect(press.defaultPrevented).toBe(true);
    await act(() => bug.click());
    expect(composer()?.value).toBe("Bug: ");
    expect(chips()).toHaveLength(0);
  });
});
