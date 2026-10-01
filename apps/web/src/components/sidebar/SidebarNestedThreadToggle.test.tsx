// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

import {
  SidebarNestedInputAttention,
  SidebarNestedThreadToggle,
} from "./SidebarNestedThreadToggle";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

it("shows recursive activity and input rollups on a collapsed nested parent", () => {
  act(() => {
    root.render(
      <>
        <SidebarNestedThreadToggle count={2} activeCount={1} expanded={false} onToggle={vi.fn()} />
        <SidebarNestedInputAttention inputCount={1} onOpenInput={vi.fn()} />
      </>,
    );
  });

  expect(container.textContent).toContain("1 active");
  expect(container.textContent).toContain("1 sub-agent needs input");
  expect(container.querySelector('[aria-label="Expand 2 sub-agents"]')).not.toBeNull();
  expect(container.querySelector('[aria-label="Open 1 sub-agent needs input"]')).not.toBeNull();
});

it("pluralizes descendant input attention", () => {
  act(() => {
    root.render(
      <>
        <SidebarNestedThreadToggle count={3} activeCount={2} expanded onToggle={vi.fn()} />
        <SidebarNestedInputAttention inputCount={2} onOpenInput={vi.fn()} />
      </>,
    );
  });

  expect(container.textContent).toContain("2 sub-agents need input");
});
