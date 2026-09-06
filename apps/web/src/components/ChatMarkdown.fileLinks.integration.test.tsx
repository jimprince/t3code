import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { AsyncResult } from "effect/unstable/reactivity";
import { act, type ComponentProps, type ReactNode } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { describe, expect, it, vi } from "vite-plus/test";
const state = vi.hoisted(() => ({
  connected: true,
  target: "BearerConnectionTarget",
  createAssetUrl: vi.fn(),
}));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => null }));
vi.mock("../hooks/useTheme", () => ({ useTheme: () => ({ resolvedTheme: "dark" }) }));
vi.mock("../hooks/useSettings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../hooks/useSettings")>();
  const settings = actual.getClientSettings();
  return {
    ...actual,
    useClientSettings: (select?: (value: typeof settings) => unknown) =>
      select ? select(settings) : settings,
  };
});
vi.mock("./ui/tooltip", async () => {
  const { cloneElement, isValidElement } = await import("react");
  return {
    Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
    TooltipTrigger({
      render,
      children,
    }: ComponentProps<typeof import("./ui/tooltip").TooltipTrigger>) {
      if (!isValidElement(render)) return <>{children}</>;
      return children === undefined ? render : cloneElement(render, undefined, children);
    },
    TooltipPopup: () => null,
  };
});
vi.mock("../state/use-atom-query-runner", () => ({
  useAtomQueryRunner: () => state.createAssetUrl,
}));
vi.mock("../state/use-atom-command", () => ({ useAtomCommand: () => state.createAssetUrl }));
vi.mock("../state/session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../state/session")>()),
  usePreparedConnection: () =>
    state.connected
      ? {
          _tag: "Some",
          value: { httpBaseUrl: "https://remote.example/", target: { _tag: state.target } },
        }
      : { _tag: "None" },
}));
vi.mock("../state/entities", () => ({
  readThreadShell: () => null,
  useProjects: () => [],
  useServerConfigs: () => new Map(),
}));
vi.mock("../remoteOpen", () => ({
  useRemoteOpenResolution: () => ({
    state: { mode: state.target === "PrimaryConnectionTarget" ? "local-exec" : "remote-links" },
    isResolved: true,
  }),
}));
vi.mock("../editorPreferences", () => ({
  useOpenInPreferredEditor: () => vi.fn(),
  usePreferredEditor: () => [null, vi.fn()],
}));
vi.mock("~/lib/openPullRequestLink", () => ({
  findProjectOnChangeRequestHost: () => undefined,
  parseChangeRequestUrl: () => null,
  resolvePullRequestPreviewTarget: () => null,
  useOpenChangeRequestLink: () => vi.fn(),
}));

import ChatMarkdown from "./ChatMarkdown";
import { useRightPanelStore } from "../rightPanelStore";

describe("markdown workspace file actions", () => {
  it.each(["BearerConnectionTarget", "PrimaryConnectionTarget", "disconnected"])(
    "routes a clicked file in %s",
    async (target) => {
      state.connected = target !== "disconnected";
      state.target = target;
      state.createAssetUrl.mockReset().mockResolvedValue(
        AsyncResult.success({
          relativeUrl: "/api/assets/signed/report.txt",
          expiresAt: Date.now() + 60_000,
        }),
      );
      const click = vi.fn();
      vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
      vi.stubGlobal("document", {
        getElementById: () => ({}),
        createElement: () => ({ href: "", rel: "", style: {}, click, remove: vi.fn() }),
        body: { append: vi.fn() },
      });
      const panel = vi.spyOn(useRightPanelStore.getState(), "openFile");
      let renderer: ReactTestRenderer | undefined;
      const threadRef = {
        environmentId: EnvironmentId.make("env"),
        threadId: ThreadId.make("thread"),
      };
      try {
        await act(async () => {
          renderer = create(
            <ChatMarkdown
              text="[Report notes](./report.txt)"
              cwd="/workspace"
              threadRef={threadRef}
            />,
          );
        });
        const anchor = renderer!.root
          .findAllByType("a")
          .find((node) => node.props.href.includes("report.txt"));
        expect(anchor).toBeDefined();
        await act(async () => {
          anchor!.props.onClick({
            preventDefault: vi.fn(),
            stopPropagation: vi.fn(),
            altKey: false,
            metaKey: false,
            ctrlKey: false,
            shiftKey: false,
          });
        });
        if (target === "BearerConnectionTarget") {
          expect(click).toHaveBeenCalledOnce();
          expect(state.createAssetUrl).toHaveBeenCalledWith({
            environmentId: "env",
            input: {
              resource: {
                _tag: "workspace-file-download",
                threadId: "thread",
                path: "/workspace/./report.txt",
              },
            },
          });
          expect(panel).not.toHaveBeenCalled();
        } else {
          expect(click).not.toHaveBeenCalled();
          expect(state.createAssetUrl).not.toHaveBeenCalled();
          expect(panel).toHaveBeenCalledWith(threadRef, "./report.txt", undefined);
        }
      } finally {
        await act(async () => renderer?.unmount());
        panel.mockRestore();
        vi.unstubAllGlobals();
      }
    },
  );
});
