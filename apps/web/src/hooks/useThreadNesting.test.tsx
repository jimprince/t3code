// @vitest-environment jsdom
import { EnvironmentId, ThreadId, type ScopedThreadRef } from "@t3tools/contracts";
import { supervisionThreadKey } from "@t3tools/client-runtime/state/fork-nesting";
import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  drop: vi.fn(),
  toast: vi.fn(),
  closeToast: vi.fn(),
  handleNewThread: vi.fn(),
  forest: { byKey: new Map<string, { id: string }>(), parentByKey: new Map<string, string>() },
  titles: new Map<string, string>(),
}));

vi.mock("../rpc/atomRegistry", () => ({ appAtomRegistry: { get: () => mocks.forest } }));
vi.mock("../state/forkSupervision", () => ({
  supervision: { forest: "forest" },
  supervisionDropCommand: {},
  useSupervisionForest: () => mocks.forest,
}));
vi.mock("../state/forkSubproject", () => ({ setThreadSubprojectCommand: {} }));
vi.mock("../state/forkPurpose", () => ({
  readThreadPurposeMove: () => null,
  setThreadPurposeCommand: {},
}));
vi.mock("../state/use-orchestration-command", () => ({
  useOrchestrationCommand: () => mocks.drop,
}));
vi.mock("./useHandleNewThread", () => ({ useNewThreadHandler: () => mocks.handleNewThread }));
vi.mock("../state/entities", () => ({
  readThreadShell: (ref: ScopedThreadRef) =>
    mocks.titles.has(ref.threadId)
      ? {
          environmentId: ref.environmentId,
          id: ref.threadId,
          projectId: "project-1",
          title: mocks.titles.get(ref.threadId),
          archivedAt: null,
        }
      : null,
  useThreadShell: (ref: ScopedThreadRef | null) =>
    ref !== null && mocks.titles.has(ref.threadId)
      ? { title: mocks.titles.get(ref.threadId), archivedAt: null }
      : null,
}));
vi.mock("../components/ui/toast", () => ({
  toastManager: { add: mocks.toast, close: mocks.closeToast },
  stackedThreadToast: (value: unknown) => value,
}));
vi.mock("../components/chat/forkThreadCommands", () => ({ readForkNestingSupported: () => true }));
vi.mock("../components/CommandPalette.logic", () => ({ ITEM_ICON_CLASS: "" }));
vi.mock("../components/ui/button", () => ({ Button: () => null }));

import {
  chooseNestedLaunch,
  readNestedDraftParent,
  useNestedDraftBannerItem,
  useThreadNestingActions,
} from "./useThreadNesting";

const env = EnvironmentId.make("env-1");
const head = ThreadId.make("head");
const child = ThreadId.make("child");
const draftId = "draft-1" as never;
const childRef: ScopedThreadRef = { environmentId: env, threadId: child };

let actions: ReturnType<typeof useThreadNestingActions>;
function Actions() {
  actions = useThreadNestingActions();
  return null;
}
function Banner() {
  useNestedDraftBannerItem(draftId, env);
  return null;
}

let renderer: ReactTestRenderer | null = null;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  mocks.drop.mockReset().mockResolvedValue({ _tag: "Success" });
  mocks.toast.mockReset().mockReturnValue("toast-1");
  mocks.handleNewThread.mockReset().mockResolvedValue({ draftId });
  mocks.titles = new Map([["head", "Head orchestrator"]]);
  mocks.forest = {
    byKey: new Map([[supervisionThreadKey({ environmentId: env, id: head }), { id: head }]]),
    parentByKey: new Map(),
  };
});

afterEach(async () => {
  await act(() => renderer?.unmount());
  renderer = null;
  vi.unstubAllGlobals();
});

async function startNestedDraft() {
  await act(() => {
    renderer = create(
      <>
        <Actions />
        <Banner />
      </>,
    );
  });
  await act(async () => {
    await actions.startNestedThread({ environmentId: env, threadId: head });
  });
}

describe("nested draft launch", () => {
  it("chooses the launch for a server that advertises it and the later attach for one that does not", () => {
    expect(chooseNestedLaunch(head, true)).toEqual({ launchParentId: head, legacyParentId: null });
    expect(chooseNestedLaunch(head, false)).toEqual({ launchParentId: null, legacyParentId: head });
    expect(chooseNestedLaunch(null, true)).toEqual({ launchParentId: null, legacyParentId: null });
    expect(chooseNestedLaunch(null, false)).toEqual({ launchParentId: null, legacyParentId: null });
  });

  it("keeps the parent a send read first even after leaving the view empties the intent", async () => {
    await startNestedDraft();
    // What the send reads as it starts, before the composer clears or an upload is awaited.
    const captured = readNestedDraftParent(draftId, env);
    expect(captured).toBe(head);
    // The draft's content cleared at send, so leaving the view drops the intent: a later read finds nothing.
    await act(() => renderer?.update(<Actions />));
    expect(readNestedDraftParent(draftId, env)).toBeNull();
    // The captured parent still decides the launch.
    expect(chooseNestedLaunch(captured, true).launchParentId).toBe(head);
  });

  it("files a thread after the launch only for a server that did not file it, and says so", async () => {
    await startNestedDraft();
    await act(async () => {
      await actions.attachNestedDraft(draftId, childRef, chooseNestedLaunch(head, false));
    });
    expect(mocks.drop).toHaveBeenCalledTimes(1);
    expect(mocks.drop.mock.calls[0]![0].input).toMatchObject({
      threadId: child,
      parentThreadId: head,
    });
    expect(mocks.toast).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Nested under Head orchestrator" }),
    );
  });

  it("only announces a thread the launch already filed, with an Undo that returns it to the sidebar", async () => {
    await startNestedDraft();
    await act(async () => {
      await actions.attachNestedDraft(draftId, childRef, chooseNestedLaunch(head, true));
    });
    expect(mocks.drop).not.toHaveBeenCalled();
    const toast = mocks.toast.mock.calls[0]![0];
    expect(toast.title).toBe("Nested under Head orchestrator");
    await act(async () => {
      toast.actionProps.onClick();
    });
    expect(mocks.drop).toHaveBeenCalledTimes(1);
    expect(mocks.drop.mock.calls[0]![0].input).toMatchObject({
      threadId: child,
      parentThreadId: null,
    });
  });
});
