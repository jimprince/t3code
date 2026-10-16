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

import { SubheadSendDialog } from "./SubheadSendDialog";

const subhead: Subhead = {
  id: "id-review",
  kind: "virtual",
  version: 2,
  enabled: true,
  retiredAt: null,
  createdAt: "2026-10-10T10:00:00.000Z",
  updatedAt: "2026-10-10T10:00:00.000Z",
  name: NamedAgentName.make("code-review"),
  projectId: ProjectId.make("project"),
  ownerThreadId: ThreadId.make("head"),
  description: "",
  prompt: "Do it.",
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt" },
  runtimeMode: "approval-required",
  concurrency: 1,
};

let root: Root;
let container: HTMLDivElement;
const onSent = vi.fn();
beforeEach(() => {
  call.mockReset();
  onSent.mockReset();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = "";
});

const open = () =>
  act(() =>
    root.render(
      <SubheadSendDialog
        environmentId={EnvironmentId.make("dev")}
        subhead={subhead}
        openRuns={[]}
        onClose={() => act(() => root.render(null))}
        onSent={onSent}
      />,
    ),
  );
const close = () => act(() => root.render(null));
const textbox = () => document.body.querySelector<HTMLTextAreaElement>("textarea")!;
const type = (value: string) =>
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(
      textbox(),
      value,
    );
    textbox().dispatchEvent(new Event("input", { bubbles: true }));
  });
const requestId = () => /request id (r-[0-9a-f]+)/.exec(document.body.textContent ?? "")?.[1];
const submit = (times = 1) =>
  act(async () => {
    const form = document.body.querySelector("form")!;
    for (let index = 0; index < times; index++) form.requestSubmit();
  });

describe("SubheadSendDialog", () => {
  it("keeps the unsent request id and text when the dialog is closed and opened again", async () => {
    open();
    const first = requestId();
    type("Review the diff on fix/cart-rounding");
    call.mockResolvedValue({ ok: false, message: "The connection dropped." });
    await submit();
    expect(document.body.textContent).toContain("The connection dropped.");
    expect(document.body.textContent).toContain("sending again is safe");
    close();
    open();
    // A request the server may already have received is retried under the same id.
    expect(requestId()).toBe(first);
    expect(textbox().value).toBe("Review the diff on fix/cart-rounding");
  });

  it("shows the receipt on success and then starts fresh", async () => {
    open();
    const first = requestId();
    type("Review it");
    call.mockResolvedValue({
      ok: true,
      value: { runId: "subhead:abcdef0123456789", status: "queued" },
    });
    await submit();
    expect(call).toHaveBeenCalledWith(
      expect.objectContaining({ requestId: first, request: "Review it" }),
    );
    expect(document.body.textContent).toContain("Sent. Run abcdef01 is queued.");
    expect(onSent).toHaveBeenCalled();
    close();
    open();
    expect(requestId()).not.toBe(first);
    expect(textbox().value).toBe("");
  });

  it("sends once when submitted twice before the first answer", async () => {
    open();
    type("Review it");
    let finish!: (value: unknown) => void;
    call.mockReturnValue(new Promise((resolve) => (finish = resolve)));
    await submit(2);
    expect(call).toHaveBeenCalledTimes(1);
    await act(async () => finish({ ok: true, value: { runId: "run-1", status: "running" } }));
  });
});
