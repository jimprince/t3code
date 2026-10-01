// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it } from "vite-plus/test";

import { SidebarThreadRowStatus } from "./SidebarThreadRowStatus";

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

it("renders the working signal used by an active nested row without continuous animation", () => {
  act(() => {
    root.render(
      <SidebarThreadRowStatus
        status={{
          label: "Working",
          icon: "working",
          className: "text-sky-600 dark:text-sky-400",
        }}
        trailing={<span aria-hidden>4m</span>}
      />,
    );
  });

  expect(container.querySelector('[role="status"]')?.textContent).toBe("Working");
  expect(container.textContent).toContain("4m");
  expect(container.querySelector("svg")?.getAttribute("class")).not.toContain("animate");
});

it("renders supervising as a static descendant-activity signal", () => {
  act(() => {
    root.render(
      <SidebarThreadRowStatus
        status={{
          label: "Supervising",
          icon: "supervising",
          className: "text-sky-600 dark:text-sky-400",
        }}
      />,
    );
  });

  expect(container.querySelector('[role="status"]')?.textContent).toBe("Supervising");
  expect(container.firstElementChild?.getAttribute("class")).toContain("text-sky-600");
  expect(container.querySelector("svg")?.getAttribute("class")).toContain("lucide-circle-dashed");
  expect(container.querySelector("svg")?.getAttribute("class")).not.toContain("animate");
});
