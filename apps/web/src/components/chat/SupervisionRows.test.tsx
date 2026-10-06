import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { supervisionForest, type ScopedSupervisionMetadata } from "@t3tools/client-runtime/state/fork-nesting";
import { makeThreadFixture } from "../../test-fixtures";
const state = vi.hoisted(() => ({
  shells: [] as ReturnType<typeof makeThreadFixture>[],
  navigate: vi.fn(),
  metadata: [] as ScopedSupervisionMetadata[],
}));
vi.mock("../../state/entities", () => ({
  useThreadShells: () => state.shells,
  useServerConfigs: () => new Map(),
  useProjects: () => [],
}));
vi.mock("../../state/forkSupervision", () => ({
  useSupervisionForest: () => supervisionForest(state.shells, state.metadata),
}));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => state.navigate }));
import { SupervisionRows } from "./SupervisionRows";
let renderer: ReactTestRenderer;
afterEach(async () => {
  await act(async () => renderer?.unmount());
  vi.unstubAllGlobals();
  state.metadata = children.map((child) => ({
    environmentId: env, threadId: child.id, parentThreadId: ThreadId.make("parent"),
  }));
  state.shells = [];
  state.metadata = [];
});
it("updates output and attention without reordering completed workers or reading child histories", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const env = EnvironmentId.make("test");
  const children = ["first", "second"].map((id) => {
    const shell = makeThreadFixture({ id: ThreadId.make(id), environmentId: env, title: id });
    return {
      ...shell,
      source: {
        ...shell.source,
        workerSummary: {
          output: "Checking",
          messageCount: 2,
          toolCount: 1,
          usedTokens: 10,
          activity: "command_execution",
          history: "v2" as const,
        },
      },
    };
  });
  state.metadata = children.map((child) => ({
    environmentId: env, threadId: child.id, parentThreadId: ThreadId.make("parent"),
  }));
  state.shells = [
    makeThreadFixture({ id: ThreadId.make("parent"), environmentId: env }),
    ...children,
  ];
  await act(async () => {
    renderer = create(<SupervisionRows environmentId={env} threadId={ThreadId.make("parent")} />);
  });
  expect(JSON.stringify(renderer.toJSON())).toContain("Checking");
  state.shells = state.shells.map((t) =>
    t.id === "first"
      ? {
          ...t,
          hasPendingUserInput: true,
          source: { ...t.source, workerSummary: { ...t.source.workerSummary!, output: "Done" } },
        }
      : t,
  );
  await act(async () =>
    renderer.update(<SupervisionRows environmentId={env} threadId={ThreadId.make("parent")} />),
  );
  const text = JSON.stringify(renderer.toJSON());
  expect(text).toContain("Done");
  expect(text).toContain("Needs input");
  const buttons = renderer.root.findAllByType("button");
  expect(buttons.map((b) => b.findAllByType("span")[0]!.children[0])).toEqual(["first", "second"]);
  expect(text).toContain("2 messages · 1 tools");
});
