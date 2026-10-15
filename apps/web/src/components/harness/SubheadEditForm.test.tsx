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

const call = vi.hoisted(() => vi.fn());
vi.mock("./useSubheadCommand", () => ({ useSubheadCall: () => call }));

import { SubheadEditForm } from "./SubheadEditForm";

const current: Subhead = {
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
};

let root: Root;
let container: HTMLDivElement;
const onSaved = vi.fn();
const onReload = vi.fn();
beforeEach(() => {
  call.mockReset();
  onSaved.mockReset();
  onReload.mockReset();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() =>
    root.render(
      <SubheadEditForm
        environmentId={EnvironmentId.make("dev")}
        subhead={current}
        projectTitle="web-app"
        ownerTitle="Platform head"
        onCancel={vi.fn()}
        onSaved={onSaved}
        onReload={onReload}
      />,
    ),
  );
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const choose = (index: number, value: string) =>
  act(() => {
    const select = container.querySelectorAll("select")[index]!;
    select.value = value;
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
const save = async () => {
  await act(async () => {
    container.querySelector<HTMLButtonElement>("button[type='submit']")!.click();
  });
};

describe("SubheadEditForm", () => {
  it("shows the fixed fields without an input and sends a new version for the pinned one", async () => {
    expect(container.textContent).toContain("Name (cannot change)");
    expect(container.textContent).toContain("Editing v7. Saving creates v8");
    call.mockResolvedValue({ ok: true, value: {} });
    await save();
    expect(call).toHaveBeenCalledWith(
      expect.objectContaining({ operation: "edit", name: "code-review", expectedVersion: 7 }),
    );
    expect(onSaved).toHaveBeenCalled();
  });

  it("asks for a second click before a broader permission is sent", async () => {
    choose(0, "full-access");
    await save();
    expect(call).not.toHaveBeenCalled();
    expect(container.textContent).toContain(
      "Runtime mode rises from approval-required to full-access.",
    );
    expect(container.textContent).toContain("Confirm and save new version");
    call.mockResolvedValue({ ok: false, message: "Only the creating principal may edit this subhead." });
    await save();
    expect(call).toHaveBeenCalledWith(
      expect.objectContaining({ template: expect.objectContaining({ runtimeMode: "full-access" }) }),
    );
    // The refusal is the server's own sentence, and the form stays open.
    expect(container.textContent).toContain("Only the creating principal may edit this subhead.");
    expect(onSaved).not.toHaveBeenCalled();
  });

  it("explains a lost update and offers a reload", async () => {
    call.mockResolvedValue({
      ok: false,
      message: "Template version conflict: expected 7, current 8.",
    });
    await save();
    expect(container.textContent).toContain("v8 was saved after you opened v7");
    act(() =>
      [...container.querySelectorAll("button")]
        .find((button) => button.textContent === "Reload v8")!
        .click(),
    );
    expect(onReload).toHaveBeenCalled();
  });

  it("rejects an empty prompt before calling the server", async () => {
    await act(async () => {
      const prompt = container.querySelector("textarea")!;
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
      setter.call(prompt, "  ");
      prompt.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await save();
    expect(call).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Prompt is required.");
  });
});
